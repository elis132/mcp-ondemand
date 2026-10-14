// The proxy: one MCP server that lists the tools, prompts and resources of every configured server from cache,
// and runs a server's process only while it is being used.
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  PromptListChangedNotificationSchema,
  ReadResourceRequestSchema,
  ResourceListChangedNotificationSchema,
  ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { DEFAULT_IDLE, ensureHome, expand, loadServers, log, readCache, writeCache } from "./config.mjs";
import { killTree, processTable, treeMemory } from "./kill.mjs";

export const VERSION = "1.1.0";
// Claude Code shows a tool as mcp__<proxy name>__<tool>, and tool names may be at most 64 characters.
const PREFIX = process.env.MCP_ONDEMAND_NAME ?? "ondemand";
const MAX_NAME = 64 - `mcp__${PREFIX}__`.length;
const CALL_TIMEOUT = 30 * 60_000;
const START_TIMEOUT = 120_000;

const shorten = (full) =>
  full.length <= MAX_NAME ? full : `${full.slice(0, MAX_NAME - 7)}_${createHash("sha1").update(full).digest("hex").slice(0, 6)}`;
// The fixed part of a URI template, before its first {variable}.
const stem = (template) => template.split("{")[0];

export class Hub {
  constructor(servers = loadServers()) {
    this.servers = servers;
    this.live = new Map(); // name -> { client, pid, starting, inFlight, timer, startedAt }
    this.stats = new Map(); // name -> { calls, starts, lastError }
    this.onChanged = () => {};
    this.rebuild();
  }

  stat(name) {
    if (!this.stats.has(name)) this.stats.set(name, { calls: 0, starts: 0, lastError: null });
    return this.stats.get(name);
  }

  cache(name) {
    return readCache(name, this.servers[name]);
  }

  // What the client sees: <server>__<name> for tools and prompts, resources under their own URIs.
  rebuild() {
    this.toolMap = new Map();
    this.promptMap = new Map();
    this.resourceMap = new Map();
    this.templateList = [];
    this.tools = [...ownTools(Object.keys(this.servers))];
    this.prompts = [];
    this.resources = [];
    this.templates = [];
    for (const name of Object.keys(this.servers)) {
      const c = this.cache(name);
      for (const tool of c?.tools ?? []) {
        const id = shorten(`${name}__${tool.name}`);
        this.toolMap.set(id, { server: name, name: tool.name });
        this.tools.push({ ...tool, name: id, description: `[${name}] ${tool.description ?? ""}`.trim() });
      }
      for (const prompt of c?.prompts ?? []) {
        const id = shorten(`${name}__${prompt.name}`);
        this.promptMap.set(id, { server: name, name: prompt.name });
        this.prompts.push({ ...prompt, name: id, description: `[${name}] ${prompt.description ?? ""}`.trim() });
      }
      for (const resource of c?.resources ?? []) {
        if (this.resourceMap.has(resource.uri)) continue;
        this.resourceMap.set(resource.uri, name);
        this.resources.push(resource);
      }
      for (const template of c?.templates ?? []) {
        this.templateList.push({ stem: stem(template.uriTemplate), server: name });
        this.templates.push(template);
      }
    }
    // Longest stem first, so the most specific template wins.
    this.templateList.sort((a, b) => b.stem.length - a.stem.length);
  }

  serverForUri(uri) {
    return this.resourceMap.get(uri) ?? this.templateList.find((t) => t.stem && uri.startsWith(t.stem))?.server;
  }

  instructions() {
    const parts = [
      "Tools named <server>__<tool> belong to separate MCP servers behind mcp-ondemand. Each starts on its first call (that call can take a few seconds) and stops when idle. ondemand_status shows which are running and their memory; ondemand_restart stops a server that hangs.",
    ];
    for (const name of Object.keys(this.servers)) {
      const text = this.cache(name)?.instructions;
      if (text) parts.push(`## ${name}\n${text}`);
    }
    return parts.join("\n\n");
  }

  async collect(client, method, key, params = {}) {
    const items = [];
    let cursor;
    do {
      const page = await client[method](cursor ? { ...params, cursor } : params);
      items.push(...page[key]);
      cursor = page.nextCursor;
    } while (cursor);
    return items;
  }

  // Store the live lists if they differ from the cache, and tell the client.
  async sync(name, client) {
    const caps = client.getServerCapabilities() ?? {};
    const data = {
      instructions: client.getInstructions?.() ?? null,
      tools: caps.tools ? await this.collect(client, "listTools", "tools") : [],
      prompts: caps.prompts ? await this.collect(client, "listPrompts", "prompts") : [],
      resources: caps.resources ? await this.collect(client, "listResources", "resources").catch(() => []) : [],
      templates: caps.resources ? await this.collect(client, "listResourceTemplates", "resourceTemplates").catch(() => []) : [],
    };
    const cached = this.cache(name);
    const same = cached && ["instructions", "tools", "prompts", "resources", "templates"].every((k) => JSON.stringify(cached[k] ?? (k === "instructions" ? null : [])) === JSON.stringify(data[k]));
    if (same) return;
    writeCache(name, this.servers[name], data);
    this.rebuild();
    this.onChanged();
    log("cache updated", name, `${data.tools.length} tools, ${data.prompts.length} prompts, ${data.resources.length + data.templates.length} resources`);
  }

  // One start per server, however many requests arrive at once.
  start(name) {
    const running = this.live.get(name);
    if (running) return running.starting;
    if (!this.servers[name]) return Promise.reject(new Error(`No server named ${name}`));
    const entry = { inFlight: 0, timer: null, startedAt: Date.now() };
    this.live.set(name, entry);
    entry.starting = (async () => {
      const def = expand(this.servers[name]);
      // Servers get the environment the client itself would give them, not the SDK's trimmed default.
      const transport = new StdioClientTransport({
        command: def.command,
        args: def.args,
        env: { ...process.env, ...def.env },
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
      const resync = () => this.sync(name, client).catch(() => {});
      client.setNotificationHandler(ToolListChangedNotificationSchema, resync);
      client.setNotificationHandler(PromptListChangedNotificationSchema, resync);
      client.setNotificationHandler(ResourceListChangedNotificationSchema, resync);
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

  // Stop after the idle time, but never while a request is running.
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

  // Run fn against a started server, holding off the idle timer meanwhile.
  async use(name, fn) {
    this.stat(name).calls++;
    let s;
    try {
      s = await this.start(name);
    } catch (err) {
      throw new Error(`Could not start MCP server ${name}: ${err?.message ?? err}`);
    }
    s.inFlight++;
    clearTimeout(s.timer);
    try {
      return await fn(s.client);
    } finally {
      s.inFlight--;
      this.arm(name);
    }
  }

  async status() {
    // What is running right now, before the slow memory read: a server may stop while it runs.
    const snapshot = new Map(this.live);
    const table = snapshot.size ? await processTable() : [];
    return Object.keys(this.servers).map((name) => {
      const s = snapshot.get(name);
      const st = this.stat(name);
      const c = this.cache(name);
      const state = s
        ? `running, pid ${s.pid ?? "starting"}, ${s.pid ? `${treeMemory(s.pid, table)} MB, ` : ""}up ${Math.round((Date.now() - s.startedAt) / 1000)}s, ${s.inFlight} in flight`
        : "stopped";
      return `${name}: ${state}; ${c ? `${c.tools?.length ?? 0} tools cached ${c.at}` : "no cache"}; ${st.calls} calls, ${st.starts} starts${st.lastError ? `; last error: ${st.lastError}` : ""}`;
    });
  }

  // extra: the SDK's request context. Its signal cancels the call on the real server too, and progress from the
  // real server is passed on when the client asked for it.
  async callTool(id, args, extra = {}) {
    if (id === "ondemand_status") return text((await this.status()).join("\n"));
    if (id === "ondemand_restart") {
      await this.stop(args?.server, "restart requested");
      return text(`${args?.server} stopped. It starts again on its next call.`);
    }
    const target = this.toolMap.get(id);
    if (!target) return text(`Unknown tool ${id}`, true);
    const token = extra.progressToken;
    try {
      return await this.use(target.server, (client) =>
        client.callTool({ name: target.name, arguments: args ?? {} }, undefined, {
          timeout: CALL_TIMEOUT,
          resetTimeoutOnProgress: true,
          signal: extra.signal,
          onprogress: token === undefined ? undefined : (p) => extra.sendNotification?.({ method: "notifications/progress", params: { ...p, progressToken: token } }).catch(() => {}),
        }),
      );
    } catch (err) {
      return text(`${target.server}: ${err?.message ?? err}`, true);
    }
  }

  getPrompt(id, args) {
    const target = this.promptMap.get(id);
    if (!target) throw new Error(`Unknown prompt ${id}`);
    return this.use(target.server, (client) => client.getPrompt({ name: target.name, arguments: args }));
  }

  readResource(uri) {
    const server = this.serverForUri(uri);
    if (!server) throw new Error(`No server offers ${uri}`);
    return this.use(server, (client) => client.readResource({ uri }));
  }
}

const text = (value, isError = false) => ({ ...(isError && { isError: true }), content: [{ type: "text", text: value }] });

function ownTools(names) {
  return [
    {
      name: "ondemand_status",
      description: "Show the MCP servers behind mcp-ondemand: which are running now, their process ids and memory, calls made and the last start error.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "ondemand_restart",
      description: "Stop one MCP server behind mcp-ondemand, for example when it hangs. It starts again on its next tool call.",
      inputSchema: { type: "object", properties: { server: { type: "string", enum: names } }, required: ["server"] },
    },
  ];
}

// Start each server once to (re)build its cache, then stop it.
export async function refresh(names, out = console.log) {
  ensureHome();
  const hub = new Hub();
  let failed = 0;
  for (const name of names ?? Object.keys(hub.servers)) {
    try {
      await hub.start(name);
      const c = hub.cache(name);
      const extra = [c?.prompts?.length && `${c.prompts.length} prompts`, (c?.resources?.length || c?.templates?.length) && `${(c.resources?.length ?? 0) + (c.templates?.length ?? 0)} resources`].filter(Boolean);
      out(`${name}: ${c?.tools?.length ?? 0} tools${extra.length ? `, ${extra.join(", ")}` : ""}`);
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
  const server = new Server(
    { name: "mcp-ondemand", version: VERSION },
    { capabilities: { tools: { listChanged: true }, prompts: { listChanged: true }, resources: { listChanged: true } }, instructions: hub.instructions() },
  );
  hub.onChanged = () => {
    for (const send of ["sendToolListChanged", "sendPromptListChanged", "sendResourceListChanged"]) server[send]().catch(() => {});
  };
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: hub.tools }));
  server.setRequestHandler(CallToolRequestSchema, async (req, extra) =>
    hub.callTool(req.params.name, req.params.arguments, { signal: extra.signal, sendNotification: extra.sendNotification, progressToken: req.params._meta?.progressToken }),
  );
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: hub.prompts }));
  server.setRequestHandler(GetPromptRequestSchema, async (req) => hub.getPrompt(req.params.name, req.params.arguments));
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: hub.resources }));
  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({ resourceTemplates: hub.templates }));
  server.setRequestHandler(ReadResourceRequestSchema, async (req) => hub.readResource(req.params.uri));
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
  // Without a cache a server is started once in the background to learn what it offers. Preload servers stay up.
  for (const [name, def] of Object.entries(hub.servers)) {
    if (def.preload) hub.start(name).catch(() => {});
    else if (!hub.cache(name)) hub.start(name).then(() => hub.stop(name, "cache built"), () => {});
  }
}
