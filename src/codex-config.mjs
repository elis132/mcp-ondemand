// Keep the user's TOML text; only change enabled and add/remove the proxy tables.
import assert from "node:assert/strict";
import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { parse, stringify } from "smol-toml";
import { BACKUPS, ensureHome, HOME, SERVERS, saveServers } from "./config.mjs";
import { codexConfigPath } from "./client.mjs";

export const ENTRY = process.env.MCP_ONDEMAND_NAME ?? "ondemand";
const BIN = fileURLToPath(new URL("../bin/mcp-ondemand.mjs", import.meta.url)).replaceAll("\\", "/");
export const configPath = ({ project } = {}) => project ? join(resolve(project), ".codex", "config.toml") : codexConfigPath();
export const readConfig = (options) => parse(readFileSync(configPath(options), "utf8"));
const readServers = () => existsSync(SERVERS) ? JSON.parse(readFileSync(SERVERS, "utf8")) : {};
const native = new Set(["node_repl", "cua_repl"]);
// Unknown permission/filter/credential settings must not silently disappear behind the proxy.
const supported = new Set(["command", "args", "cwd", "env", "enabled", "startup_timeout_sec", "tool_timeout_sec"]);

function tables(text) {
  const rows = [];
  for (const m of text.matchAll(/^[ \t]*(\[[^\n]+\])[ \t]*(?:#.*)?\r?$/gm)) {
    try {
      let value = parse(m[1] + "\n__ondemand_marker__ = true\n");
      const path = [];
      while (!Object.hasOwn(value, "__ondemand_marker__")) {
        const keys = Object.keys(value);
        if (keys.length !== 1 || Array.isArray(value[keys[0]])) throw new Error("not a table");
        path.push(keys[0]); value = value[keys[0]];
      }
      rows.push({ path, start: m.index, body: m.index + m[0].length });
    } catch { /* Other TOML lines are verified by parsing the final document before writing. */ }
  }
  return rows.map((row, i) => ({ ...row, end: rows[i + 1]?.start ?? text.length }));
}

function enabled(text, name, value) {
  const row = tables(text).find((r) => r.path.length === 2 && r.path[0] === "mcp_servers" && r.path[1] === name);
  if (!row) throw new Error(`Cannot safely edit ${name}: use a [mcp_servers.${name}] table.`);
  let body = text.slice(row.body, row.end);
  const assignment = /^[ \t]*enabled[ \t]*=[ \t]*(?:true|false)[ \t]*(?:#[^\n]*)?\r?\n?/m;
  if (assignment.test(body)) body = body.replace(assignment, (line) => value === undefined ? "" : line.replace(/(=[ \t]*)(?:true|false)/, `$1${value}`));
  else if (value !== undefined) body = `\nenabled = ${value}${body}`;
  return text.slice(0, row.body) + body + text.slice(row.end);
}

function withoutProxy(text) {
  for (const row of tables(text).filter((r) => r.path[0] === "mcp_servers" && r.path[1] === ENTRY).reverse()) {
    text = text.slice(0, row.start) + text.slice(row.end);
  }
  return text;
}

function writeConfig(file, text, expected) {
  // Reject unusual TOML layouts instead of risking unrelated settings or multiline strings.
  assert.deepEqual(structuredClone(parse(text)), structuredClone(expected), "TOML edit would change unrelated settings; no files written");
  ensureHome();
  const backup = join(BACKUPS, `codex-config.${Date.now()}.${randomUUID()}.toml`);
  copyFileSync(file, backup);
  const temp = `${file}.ondemand-${randomUUID()}`;
  writeFileSync(temp, text);
  renameSync(temp, file);
  return backup;
}

export function importServers({ project, only, except, dryRun } = {}) {
  const file = configPath({ project });
  let text = readFileSync(file, "utf8");
  const config = parse(text);
  const expected = structuredClone(config);
  const servers = readServers();
  const moved = [], skipped = [];
  for (const [name, s] of Object.entries(config.mcp_servers ?? {})) {
    if (name === ENTRY) continue;
    if (!s.command || s.enabled === false || native.has(name) || Object.keys(s).some((k) => !supported.has(k)) || (only && !only.includes(name)) || except?.includes(name)) {
      skipped.push(name); continue;
    }
    if (servers[name] && servers[name].codex?.configPath !== file) throw new Error(`Server name collision: ${name}. Use a separate MCP_ONDEMAND_HOME.`);
    const previous = servers[name] ?? {};
    servers[name] = {
      command: s.command, args: s.args ?? [], ...(s.env && { env: s.env }), ...(s.cwd && { cwd: s.cwd }),
      ...(s.startup_timeout_sec !== undefined && { startupTimeout: s.startup_timeout_sec * 1000 }),
      ...(s.tool_timeout_sec !== undefined && { toolTimeout: s.tool_timeout_sec * 1000 }),
      perSession: previous.perSession ?? true, idle: previous.idle ?? 1800,
      ...Object.fromEntries(["maxMemory", "preload", "disabled"].filter((k) => previous[k] !== undefined).map((k) => [k, previous[k]])),
      codex: { configPath: file, original: s },
    };
    text = enabled(text, name, false);
    expected.mcp_servers[name].enabled = false;
    moved.push(name);
  }
  if (dryRun || !moved.length) return { moved, skipped, scope: file, client: "codex" };
  const entry = { command: process.execPath, args: [BIN, "serve", "--client", "codex"], startup_timeout_sec: 120, tool_timeout_sec: 1800, env: { MCP_ONDEMAND_HOME: HOME, MCP_ONDEMAND_CLIENT: "codex" } };
  if (config.mcp_servers?.[ENTRY]) {
    assert.deepEqual(structuredClone(config.mcp_servers[ENTRY]), entry, `A different proxy named ${ENTRY} already exists; restore it first.`);
  } else {
    text += "\n" + stringify({ mcp_servers: { [ENTRY]: entry } });
    expected.mcp_servers[ENTRY] = entry;
  }
  const backup = writeConfig(file, text, expected);
  saveServers(servers);
  return { moved, skipped, scope: file, client: "codex", backup };
}

export function restoreServers({ only, project } = {}) {
  const file = configPath({ project });
  let text = readFileSync(file, "utf8");
  const expected = parse(text), servers = readServers(), restored = [];
  for (const [name, s] of Object.entries(servers)) {
    if (s.codex?.configPath !== file || (only && !only.includes(name))) continue;
    if (!expected.mcp_servers?.[name]) throw new Error(`Cannot restore ${name}: its original table was removed.`);
    const value = s.codex.original.enabled;
    text = enabled(text, name, value);
    if (value === undefined) delete expected.mcp_servers[name].enabled;
    else expected.mcp_servers[name].enabled = value;
    restored.push(name); delete servers[name];
  }
  if (!restored.length) return { restored, plugins: [] };
  if (!Object.values(servers).some((s) => s.codex?.configPath === file)) {
    text = withoutProxy(text); delete expected.mcp_servers[ENTRY];
  }
  const backup = writeConfig(file, text, expected);
  saveServers(servers);
  return { restored, plugins: [], backup };
}
