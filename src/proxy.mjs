// The proxy: one MCP server that lists the tools of every configured server from cache, and runs a server's
// process only while it is being used.
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { DEFAULT_IDLE, ensureHome, loadServers, log, readCache, writeCache } from "./config.mjs";
import { killTree } from "./kill.mjs";

const VERSION = "1.0.0";
// Claude Code shows a tool as mcp__<proxy name>__<tool>, and tool names may be at most 64 characters.
const PREFIX = process.env.MCP_ONDEMAND_NAME ?? "ondemand";
const MAX_NAME = 64 - `mcp__${PREFIX}__`.length;
const CALL_TIMEOUT = 30 * 60_000;
const START_TIMEOUT = 120_000;

export class Hub {
  constructor(servers = loadServers()) {
    this.servers = servers;
    this.live = new Map(); // name -> { client, pid, starting, inFlight, timer, startedAt }
    this.stats = new Map(); // name -> { calls, starts, lastError }
    this.onToolsChanged = () => {};
    this.rebuild();
  }

  stat(name) {
    if (!this.stats.has(name)) this.stats.set(name, { calls: 0, starts: 0, lastError: null });
    return this.stats.get(name);
  }

  cache(name) {
    return readCache(name, this.servers[name]);
  }

  // The table of tools Claude sees: <server>__<tool>, shortened with a hash when too long.
  rebuild() {
    this.table = new Map();
    this.tools = [...ownTools(Object.keys(this.servers))];
    for (const name of Object.keys(this.servers)) {
      for (const tool of this.cache(name)?.tools ?? []) {
        const full = `${name}__${tool.name}`;
        const id = full.length <= MAX_NAME ? full : `${full.slice(0, MAX_NAME - 7)}_${createHash("sha1").update(full).digest("hex").slice(0, 6)}`;
        this.table.set(id, { server: name, tool: tool.name });
        this.tools.push({ ...tool, name: id, description: `[${name}] ${tool.description ?? ""}`.trim() });
      }
    }
  }

  instructions() {
    const parts = [
      "Tools named <server>__<tool> belong to separate MCP servers behind mcp-ondemand. Each starts on its first call (that call can take a few seconds) and stops when idle. ondemand_status shows which are running; ondemand_restart stops a server that hangs.",
    ];
    for (const name of Object.keys(this.servers)) {
      const text = this.cache(name)?.instructions;
      if (text) parts.push(`## ${name}\n${text}`);
    }
    return parts.join("\n\n");
  }

  async listAll(client) {
    const tools = [];
    let cursor;
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined);
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor);
    return tools;
  }

  // Store the live tool list if it differs from the cache, and tell the client.
  async sync(name, client) {
    const tools = await this.listAll(client);
    const cached = this.cache(name);
    if (cached && JSON.stringify(cached.tools) === JSON.stringify(tools)) return tools;
    writeCache(name, this.servers[name], tools, client.getInstructions?.());
    this.rebuild();
    this.onToolsChanged();
    log("cache updated", name, tools.length, "tools");
    return tools;
  }

  // One start per server, however many calls arrive at once.
  start(name) {
    const running = this.live.get(name);
    if (running) return running.starting;
    const def = this.servers[name];
    if (!def) return Promise.reject(new Error(`No server named ${name}`));
    const entry = { inFlight: 0, timer: null, startedAt: Date.now() };
    this.live.set(name, entry);
    entry.starting = (async () => {
      // Servers get the environment the client itself would give them, not the SDK's trimmed default.
      const transport = new StdioClientTransport({
        command: def.command,
        args: def.args ?? [],
        env: { ...process.env, ...(def.env ?? {}) },
        cwd: def.cwd,
        stderr: "ignore",
      });
      const client = new Client({ name: "mcp-ondemand", version: VERSION });
      transport.onclose = () => {
        if (this.live.get(name) !== entry) return;
        log("exited", name);
        this.live.delete(name);
        clearTimeout(entry.timer);
      };
      client.setNotificationHandler(ToolListChangedNotificationSchema, () => this.sync(name, client).catch(() => {}));
      await client.connect(transport, { timeout: START_TIMEOUT });
      Object.assign(entry, { client, pid: transport.pid });
      this.stat(name).starts++;
      log("start", name, "pid", transport.pid);
      await this.sync(name, client);
      this.arm(name);
      return entry;
    })().catch(async (err) => {
      this.stat(name).lastError = String(err?.message ?? err);
      log("start failed", name, this.stat(name).lastError);
      await this.stop(name, "start failed");
      throw err;
    });
    return entry.starting;
  }

  async stop(name, why) {
    const s = this.live.get(name);
    if (!s) return;
    this.live.delete(name);
    clearTimeout(s.timer);
    log("stop", name, why);
    killTree(s.pid);
    await s.client?.close().catch(() => {});
  }

  stopAll(why) {
    return Promise.all([...this.live.keys()].map((name) => this.stop(name, why)));
  }

  // Stop after the idle time, but never while a call is running.
  arm(name) {
    const s = this.live.get(name);
    if (!s) return;
    clearTimeout(s.timer);
    const idle = this.servers[name].idle ?? DEFAULT_IDLE;
    if (idle > 0 && s.inFlight === 0) {
      s.timer = setTimeout(() => s.inFlight === 0 && this.stop(name, `idle ${idle}s`), idle * 1000);
      s.timer.unref?.();
    }
  }

  status() {
    return Object.keys(this.servers).map((name) => {
      const s = this.live.get(name);
      const st = this.stat(name);
      const cached = this.cache(name);
      const state = s ? `running, pid ${s.pid ?? "starting"}, up ${Math.round((Date.now() - s.startedAt) / 1000)}s, ${s.inFlight} in flight` : "stopped";
      return `${name}: ${state}; ${cached ? `${cached.tools.length} tools cached ${cached.at}` : "no cache"}; ${st.calls} calls, ${st.starts} starts${st.lastError ? `; last error: ${st.lastError}` : ""}`;
    });
  }

  async call(id, args) {
    if (id === "ondemand_status") return text(this.status().join("\n"));
    if (id === "ondemand_restart") {
      await this.stop(args?.server, "restart requested");
      return text(`${args?.server} stopped. It starts again on its next call.`);
    }
    const target = this.table.get(id);
    if (!target) return text(`Unknown tool ${id}`, true);
    this.stat(target.server).calls++;
    let s;
    try {
      s = await this.start(target.server);
    } catch (err) {
      return text(`Could not start MCP server ${target.server}: ${err?.message ?? err}`, true);
    }
    s.inFlight++;
    clearTimeout(s.timer);
    try {
      return await s.client.callTool({ name: target.tool, arguments: args ?? {} }, undefined, { timeout: CALL_TIMEOUT, resetTimeoutOnProgress: true });
    } catch (err) {
      return text(`${target.server} failed: ${err?.message ?? err}`, true);
    } finally {
      s.inFlight--;
      this.arm(target.server);
    }
  }
}

const text = (value, isError = false) => ({ ...(isError && { isError: true }), content: [{ type: "text", text: value }] });

function ownTools(names) {
  return [
    {
      name: "ondemand_status",
      description: "Show the MCP servers behind mcp-ondemand: which are running now, process ids, calls made and the last start error.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "ondemand_restart",
      description: "Stop one MCP server behind mcp-ondemand, for example when it hangs. It starts again on its next tool call.",
      inputSchema: { type: "object", properties: { server: { type: "string", enum: names } }, required: ["server"] },
    },
  ];
}

// Start each server once to (re)build its cached tool list, then stop it.
export async function refresh(names, out = console.log) {
  ensureHome();
  const hub = new Hub();
  let failed = 0;
  for (const name of names ?? Object.keys(hub.servers)) {
    try {
      await hub.start(name);
      out(`${name}: ${hub.cache(name)?.tools.length ?? 0} tools`);
    } catch (err) {
      failed++;
      out(`${name}: FAILED ${err?.message ?? err}`);
    }
    await hub.stop(name, "refresh done");
  }
  return failed;
}

export async function serve() {
  ensureHome();
  const hub = new Hub();
  const server = new Server({ name: "mcp-ondemand", version: VERSION }, { capabilities: { tools: { listChanged: true } }, instructions: hub.instructions() });
  hub.onToolsChanged = () => server.sendToolListChanged().catch(() => {});
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: hub.tools }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => hub.call(req.params.name, req.params.arguments));
  // Nothing outlives the session.
  let ending = false;
  const shutdown = async () => {
    if (ending) return;
    ending = true;
    await hub.stopAll("session ended");
    process.exit(0);
  };
  process.stdin.on("close", shutdown);
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  await server.connect(new StdioServerTransport());
  log("ready", hub.tools.length, "tools");
  // Without a cache a server is started once in the background to learn its tools. Preload servers stay up.
  for (const [name, def] of Object.entries(hub.servers)) {
    if (def.preload) hub.start(name).catch(() => {});
    else if (!hub.cache(name)) hub.start(name).then(() => hub.stop(name, "cache built"), () => {});
  }
}
