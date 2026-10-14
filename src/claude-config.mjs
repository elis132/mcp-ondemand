// Moving MCP servers from Claude Code's config (~/.claude.json) behind mcp-ondemand, and back again.
import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKUPS, ensureHome, SERVERS, saveServers } from "./config.mjs";

export const CLAUDE_JSON = process.env.MCP_ONDEMAND_CLAUDE_JSON ?? join(homedir(), ".claude.json");
export const ENTRY = process.env.MCP_ONDEMAND_NAME ?? "ondemand";
const BIN = fileURLToPath(new URL("../bin/mcp-ondemand.mjs", import.meta.url)).replaceAll("\\", "/");
// Fields that belong to mcp-ondemand, not to Claude Code.
const OWN_FIELDS = ["idle", "preload", "disabled", "from"];

const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
const readServersFile = () => (existsSync(SERVERS) ? readJson(SERVERS) : {});

function writeClaude(config) {
  ensureHome();
  const backup = join(BACKUPS, `claude.json.${new Date().toISOString().replace(/[:.]/g, "-")}`);
  copyFileSync(CLAUDE_JSON, backup);
  // Claude Code rewrites this file itself, so replace it in one step.
  const tmp = `${CLAUDE_JSON}.ondemand-tmp`;
  writeFileSync(tmp, JSON.stringify(config, null, 2));
  renameSync(tmp, CLAUDE_JSON);
  return backup;
}

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
  for (const [name, s] of Object.entries(servers)) {
    if (only && !only.includes(name)) continue;
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
  const backup = writeClaude(config);
  return { restored, backup };
}
