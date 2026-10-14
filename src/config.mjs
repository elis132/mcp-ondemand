// Where mcp-ondemand keeps its files, and the per-server cache.
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const HOME = process.env.MCP_ONDEMAND_HOME ?? join(homedir(), ".mcp-ondemand");
export const SERVERS = join(HOME, "servers.json");
export const CACHE = join(HOME, "cache");
export const BACKUPS = join(HOME, "backups");
export const LOG = join(HOME, "ondemand.log");
export const DEFAULT_IDLE = 600;

export function ensureHome() {
  mkdirSync(CACHE, { recursive: true });
  mkdirSync(BACKUPS, { recursive: true });
}

export function log(...parts) {
  try {
    appendFileSync(LOG, `${new Date().toISOString()} ${parts.join(" ")}\n`);
  } catch {}
}

// { "<name>": { command, args?, env?, cwd?, idle?, preload?, disabled? } }
export function loadServers() {
  if (!existsSync(SERVERS)) return {};
  const all = JSON.parse(readFileSync(SERVERS, "utf8"));
  return Object.fromEntries(Object.entries(all).filter(([, s]) => !s.disabled));
}

export const saveServers = (servers) => writeFileSync(SERVERS, `${JSON.stringify(servers, null, 2)}\n`);

// ${NAME} and ${NAME:-fallback} in command, args, env and cwd come from the environment, so secrets can stay out
// of servers.json. Unset without a fallback: an error that names the variable, not a silently empty value.
export function expand(server, env = process.env) {
  const one = (value) =>
    typeof value !== "string"
      ? value
      : value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_, name, fallback) => {
          if (env[name] !== undefined) return env[name];
          if (fallback !== undefined) return fallback;
          throw new Error(`environment variable ${name} is not set`);
        });
  return {
    ...server,
    command: one(server.command),
    args: (server.args ?? []).map(one),
    env: Object.fromEntries(Object.entries(server.env ?? {}).map(([k, v]) => [k, one(v)])),
    cwd: one(server.cwd),
  };
}

// The cache belongs to one way of starting a server: change its command, args, env or cwd and it is rebuilt.
// Env values are hashed, never written to the cache.
export const keyOf = (s) =>
  createHash("sha256").update(JSON.stringify([s.command, s.args ?? [], s.env ?? {}, s.cwd ?? ""])).digest("hex");

const cacheFile = (name) => join(CACHE, `${encodeURIComponent(name)}.json`);

// { key, at, instructions, tools, prompts, resources, templates }
export function readCache(name, server) {
  try {
    const c = JSON.parse(readFileSync(cacheFile(name), "utf8"));
    return c.key === keyOf(server) ? c : null;
  } catch {
    return null;
  }
}

export function writeCache(name, server, data) {
  writeFileSync(cacheFile(name), JSON.stringify({ key: keyOf(server), at: new Date().toISOString(), ...data }));
}

export const dropCache = (name) => {
  try {
    writeFileSync(cacheFile(name), "{}");
  } catch {}
};
