// Where mcp-ondemand keeps its files, and the per-server tool cache.
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

// The cache belongs to one way of starting a server: change its command, args, env or cwd and it is rebuilt.
// Env values are hashed, never written to the cache.
export const keyOf = (s) =>
  createHash("sha256").update(JSON.stringify([s.command, s.args ?? [], s.env ?? {}, s.cwd ?? ""])).digest("hex");

const cacheFile = (name) => join(CACHE, `${encodeURIComponent(name)}.json`);

export function readCache(name, server) {
  try {
    const c = JSON.parse(readFileSync(cacheFile(name), "utf8"));
    return c.key === keyOf(server) ? c : null;
  } catch {
    return null;
  }
}

export function writeCache(name, server, tools, instructions) {
  writeFileSync(cacheFile(name), JSON.stringify({ key: keyOf(server), at: new Date().toISOString(), instructions: instructions ?? null, tools }));
}

export const dropCache = (name) => {
  try {
    writeFileSync(cacheFile(name), "{}");
  } catch {}
};
