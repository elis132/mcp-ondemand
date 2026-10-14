// Moving MCP servers from Claude Code's config (~/.claude.json) behind mcp-ondemand, and back again.
import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKUPS, ensureHome, SERVERS, saveServers } from "./config.mjs";

export const CLAUDE_JSON = process.env.MCP_ONDEMAND_CLAUDE_JSON ?? join(homedir(), ".claude.json");
export const CLAUDE_DIR = process.env.MCP_ONDEMAND_CLAUDE_DIR ?? join(homedir(), ".claude");
const SETTINGS = join(CLAUDE_DIR, "settings.json");
export const ENTRY = process.env.MCP_ONDEMAND_NAME ?? "ondemand";
const BIN = fileURLToPath(new URL("../bin/mcp-ondemand.mjs", import.meta.url)).replaceAll("\\", "/");
// Fields that belong to mcp-ondemand, not to Claude Code.
const OWN_FIELDS = ["idle", "preload", "disabled", "from"];

const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
const readServersFile = () => (existsSync(SERVERS) ? readJson(SERVERS) : {});

// Back up, then replace in one step: Claude Code rewrites these files itself.
function writeJson(file, data, label) {
  ensureHome();
  const backup = join(BACKUPS, `${label}.${new Date().toISOString().replace(/[:.]/g, "-")}`);
  if (existsSync(file)) copyFileSync(file, backup);
  const tmp = `${file}.ondemand-tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, file);
  return backup;
}
const writeClaude = (config) => writeJson(CLAUDE_JSON, config, "claude.json");

// The places in ~/.claude.json that hold servers: user level, or one project.
function scopeOf(config, project) {
  if (!project) return { label: "user", servers: (config.mcpServers ??= {}) };
  const projects = (config.projects ??= {});
  const wanted = resolve(project).replaceAll("\\", "/").toLowerCase();
  const key = Object.keys(projects).find((k) => resolve(k).replaceAll("\\", "/").toLowerCase() === wanted) ?? resolve(project);
  projects[key] ??= {};
  return { label: key, servers: (projects[key].mcpServers ??= {}) };
}

const isLocal = (s) => (s.type ?? "stdio") === "stdio" && s.command;

export function importServers({ project, only, except, dryRun } = {}) {
  const config = readJson(CLAUDE_JSON);
  const scope = scopeOf(config, project);
  const existing = readServersFile();
  const moved = [];
  const skipped = [];
  for (const [name, s] of Object.entries(scope.servers)) {
    if (name === ENTRY) continue;
    if (!isLocal(s) || (only && !only.includes(name)) || except?.includes(name)) {
      skipped.push(name);
      continue;
    }
    const own = Object.fromEntries(OWN_FIELDS.filter((f) => existing[name]?.[f] !== undefined).map((f) => [f, existing[name][f]]));
    existing[name] = { command: s.command, args: s.args ?? [], ...(s.env && Object.keys(s.env).length && { env: s.env }), ...(s.cwd && { cwd: s.cwd }), ...own, from: scope.label };
    delete scope.servers[name];
    moved.push(name);
  }
  if (dryRun) return { moved, skipped, scope: scope.label };
  scope.servers[ENTRY] = { type: "stdio", command: "node", args: [BIN], env: {} };
  ensureHome();
  saveServers(existing);
  const backup = writeClaude(config);
  return { moved, skipped, scope: scope.label, backup };
}

export function restoreServers({ only } = {}) {
  const config = readJson(CLAUDE_JSON);
  const servers = readServersFile();
  const restored = [];
  const plugins = [];
  for (const [name, s] of Object.entries(servers)) {
    if (only && !only.includes(name)) continue;
    // A plugin's server goes back by switching the plugin on again.
    if (s.from?.startsWith("plugin:")) {
      plugins.push(s.from.slice("plugin:".length));
      restored.push(name);
      delete servers[name];
      continue;
    }
    const scope = scopeOf(config, s.from && s.from !== "user" ? s.from : undefined);
    const clean = Object.fromEntries(Object.entries(s).filter(([k]) => !OWN_FIELDS.includes(k)));
    scope.servers[name] = { type: "stdio", env: {}, ...clean };
    restored.push(name);
    delete servers[name];
  }
  // Without servers left, the proxy entry goes too.
  if (!Object.keys(servers).length) {
    delete scopeOf(config).servers[ENTRY];
    for (const p of Object.values(config.projects ?? {})) delete p.mcpServers?.[ENTRY];
  }
  saveServers(servers);
  if (plugins.length) setPlugins(plugins, true);
  const backup = writeClaude(config);
  return { restored, backup, plugins };
}

// ---- servers that come from Claude Code plugins ----

function setPlugins(keys, enabled) {
  const settings = existsSync(SETTINGS) ? readJson(SETTINGS) : {};
  settings.enabledPlugins ??= {};
  for (const key of keys) settings.enabledPlugins[key] = enabled;
  return writeJson(SETTINGS, settings, "settings.json");
}

// The MCP servers of every enabled plugin: from its .mcp.json, or mcpServers in its plugin.json.
export function pluginServers() {
  const installed = join(CLAUDE_DIR, "plugins", "installed_plugins.json");
  if (!existsSync(installed)) return [];
  const enabled = existsSync(SETTINGS) ? readJson(SETTINGS).enabledPlugins ?? {} : {};
  const found = [];
  for (const [key, installs] of Object.entries(readJson(installed).plugins ?? {})) {
    if (enabled[key] !== true) continue;
    const root = [].concat(installs).at(-1)?.installPath;
    if (!root) continue;
    const sources = [];
    const manifest = join(root, ".claude-plugin", "plugin.json");
    const declared = existsSync(manifest) ? readJson(manifest).mcpServers : undefined;
    if (typeof declared === "string") sources.push(join(root, declared));
    else if (declared) sources.push(declared);
    if (existsSync(join(root, ".mcp.json"))) sources.push(join(root, ".mcp.json"));
    for (const source of sources) {
      const raw = typeof source === "string" ? readJson(source) : source;
      for (const [name, s] of Object.entries(raw.mcpServers ?? raw)) {
        // ${CLAUDE_PLUGIN_ROOT} only exists inside Claude Code, so it is filled in here.
        const fill = (v) => (typeof v === "string" ? v.replaceAll("${CLAUDE_PLUGIN_ROOT}", root.replaceAll("\\", "/")) : v);
        found.push({
          plugin: key,
          name,
          server: { ...s, command: fill(s.command), args: (s.args ?? []).map(fill), env: Object.fromEntries(Object.entries(s.env ?? {}).map(([k, v]) => [k, fill(v)])), cwd: fill(s.cwd) },
        });
      }
    }
  }
  return found;
}

// Move plugin MCP servers behind mcp-ondemand and switch those plugins off. A plugin with remote servers, or
// anything not selected, is left alone, since switching it off would lose those too.
export function importPlugins({ only, except, dryRun } = {}) {
  const existing = readServersFile();
  const all = pluginServers();
  const pick = (p) => (!only || only.includes(p.name) || only.includes(p.plugin)) && !except?.includes(p.name) && !except?.includes(p.plugin);
  const byPlugin = new Map();
  for (const p of all) byPlugin.set(p.plugin, [...(byPlugin.get(p.plugin) ?? []), p]);
  const moved = [];
  const skipped = [];
  const plugins = [];
  for (const [plugin, entries] of byPlugin) {
    if (!entries.every((p) => isLocal(p.server) && pick(p))) {
      skipped.push(...entries.map((p) => `${p.name} (${plugin})`));
      continue;
    }
    plugins.push(plugin);
    for (const p of entries) {
      const taken = existing[p.name] && existing[p.name].from !== `plugin:${plugin}`;
      const name = taken ? `${plugin.split("@")[0]}-${p.name}` : p.name;
      const own = Object.fromEntries(OWN_FIELDS.filter((f) => existing[name]?.[f] !== undefined).map((f) => [f, existing[name][f]]));
      const { type, ...server } = p.server;
      existing[name] = { ...server, ...own, from: `plugin:${plugin}` };
      if (!existing[name].cwd) delete existing[name].cwd;
      if (!Object.keys(existing[name].env ?? {}).length) delete existing[name].env;
      moved.push(name);
    }
  }
  if (dryRun || !moved.length) return { moved, skipped, plugins };
  // The proxy itself must be registered for the moved servers to be reachable.
  const config = readJson(CLAUDE_JSON);
  const user = scopeOf(config).servers;
  let backup;
  if (!user[ENTRY]) {
    user[ENTRY] = { type: "stdio", command: "node", args: [BIN], env: {} };
    backup = writeClaude(config);
  }
  saveServers(existing);
  const settingsBackup = setPlugins(plugins, false);
  return { moved, skipped, plugins, backup, settingsBackup };
}
