// mcp-ondemand against a fake server, through a real MCP client.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (check, ms = 5000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) if (check()) return true;
  return check();
};
const alive = (p) => {
  try {
    process.kill(p, 0);
    return true;
  } catch {
    return false;
  }
};
const text = (r) => r.content[0].text;

// A fresh home with one fake server. Returns helpers to read what the fake server logged.
function setup(extra = {}, env = {}) {
  const home = mkdtempSync(join(tmpdir(), "mcp-ondemand-"));
  const fakeLog = join(home, "fake.log");
  writeFileSync(join(home, "servers.json"), JSON.stringify({
    fake: { command: process.execPath, args: [join(root, "test", "fake-server.mjs")], env: { FAKE_LOG: fakeLog }, idle: 2, ...extra },
  }));
  const lines = () => (existsSync(fakeLog) ? readFileSync(fakeLog, "utf8").trim().split("\n") : []);
  const startLines = () => lines().filter((l) => l.startsWith("start"));
  return {
    home,
    lines,
    starts: () => startLines().length,
    pid: (i) => Number(startLines()[i].split(" ")[1]),
    async connect() {
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [join(root, "bin", "mcp-ondemand.mjs")],
        // These tests cover a session on its own; shared.test.mjs covers the daemon.
        env: { ...process.env, ...env, MCP_ONDEMAND_HOME: home, MCP_ONDEMAND_SHARED: "0" },
        cwd: root,
      });
      const client = new Client({ name: "test", version: "1" });
      await client.connect(transport);
      return client;
    },
    async warm() {
      // A cold cache is filled in the background on the first connect.
      const client = await this.connect();
      assert.ok(await until(() => existsSync(join(home, "cache", "fake.json")) && this.starts() === 1 && !alive(this.pid(0))), "cache built and server stopped");
      await client.close();
      return this.connect();
    },
  };
}

test("servers start on first use, stop when idle, and never outlive the session", async () => {
  const f = setup();
  const client = await f.warm();
  try {
    await lifecycle(f, client);
  } finally {
    await client.close();
  }
});

async function lifecycle(f, client) {
  // Warm cache: tools and instructions come from the cache, nothing is started.
  const names = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["fake__crash", "fake__cwd", "fake__echo", "fake__env", "fake__progress", "fake__slow", "ondemand_restart", "ondemand_status"]);
  assert.match(client.getInstructions(), /Fake server instructions/);
  await sleep(300);
  assert.equal(f.starts(), 1, "listing tools starts nothing");

  // Two first calls at once share one start.
  const [a, b] = await Promise.all([
    client.callTool({ name: "fake__echo", arguments: { text: "a" } }),
    client.callTool({ name: "fake__echo", arguments: { text: "b" } }),
  ]);
  assert.deepEqual([text(a), text(b)], ["echo:a", "echo:b"]);
  assert.equal(f.starts(), 2);

  // A call longer than the idle time is not cut off.
  assert.equal(text(await client.callTool({ name: "fake__slow", arguments: { ms: 3000 } })), "done");
  assert.equal(f.starts(), 2);

  // Status shows it running, with its memory.
  assert.match(text(await client.callTool({ name: "ondemand_status", arguments: {} })), /fake: running, pid \d+, \d+ MB/);

  // Idle for 2 s: stopped. The next call starts it again.
  assert.ok(await until(() => !alive(f.pid(1))), "idle server stopped");
  assert.equal(text(await client.callTool({ name: "fake__echo", arguments: { text: "c" } })), "echo:c");
  assert.equal(f.starts(), 3);

  // A crash is reported, and the next call gets a fresh server.
  assert.equal((await client.callTool({ name: "fake__crash", arguments: {} })).isError, true);
  await sleep(300);
  assert.equal(text(await client.callTool({ name: "fake__echo", arguments: { text: "d" } })), "echo:d");
  assert.equal(f.starts(), 4);

  // ondemand_restart stops it on request.
  await client.callTool({ name: "ondemand_restart", arguments: { server: "fake" } });
  assert.ok(await until(() => !alive(f.pid(3))));

  // The session ends: nothing is left running.
  await client.callTool({ name: "fake__echo", arguments: { text: "e" } });
  const last = f.pid(4);
  assert.ok(alive(last));
  await client.close();
  assert.ok(await until(() => !alive(last)), "server killed when the session ended");
}

test("prompts, resources, progress, cancellation and ${VAR} reach the real server", async () => {
  const f = setup({ env: { FAKE_LOG: "${FAKE_LOG_PATH}", SECRET: "${ONDEMAND_TEST_SECRET:-fallback}" } }, {});
  // The log path itself comes from the environment, through ${FAKE_LOG_PATH}.
  process.env.FAKE_LOG_PATH = join(f.home, "fake.log");
  process.env.ONDEMAND_TEST_SECRET = "from-env";
  const client = await f.warm();
  try {
    await promptsResourcesProgress(f, client);
  } finally {
    await client.close();
  }
});

async function promptsResourcesProgress(f, client) {
  assert.equal(text(await client.callTool({ name: "fake__env", arguments: { name: "SECRET" } })), "from-env");

  const prompts = (await client.listPrompts()).prompts.map((p) => p.name);
  assert.deepEqual(prompts, ["fake__greet"]);
  const prompt = await client.getPrompt({ name: "fake__greet", arguments: { who: "Ada" } });
  assert.equal(prompt.messages[0].content.text, "Hello Ada");

  assert.deepEqual((await client.listResources()).resources.map((r) => r.uri), ["fake://readme"]);
  assert.deepEqual((await client.listResourceTemplates()).resourceTemplates.map((t) => t.uriTemplate), ["note://{id}"]);
  assert.equal((await client.readResource({ uri: "fake://readme" })).contents[0].text, "fake readme");
  assert.equal((await client.readResource({ uri: "note://42" })).contents[0].text, "note 42");

  // Progress from the real server arrives at the client.
  const seen = [];
  const r = await client.callTool({ name: "fake__progress", arguments: {} }, undefined, { onprogress: (p) => seen.push(p.progress) });
  assert.equal(text(r), "progressed");
  assert.deepEqual(seen, [1, 2, 3]);

  // Cancelling a call cancels it on the real server too.
  const abort = new AbortController();
  const pending = client.callTool({ name: "fake__slow", arguments: { ms: 10_000 } }, undefined, { signal: abort.signal });
  await sleep(500);
  abort.abort();
  await assert.rejects(pending);
  assert.ok(await until(() => f.lines().some((l) => l.startsWith("cancelled"))), "the real server saw the cancellation");
}

test("an unset ${VAR} without fallback is reported by name", async () => {
  const f = setup({ env: { FAKE_LOG: "x", NEEDED: "${ONDEMAND_TEST_UNSET_VAR}" } });
  // Seed a cache by hand so the tool is listed without a start.
  const { keyOf } = await import("../src/config.mjs");
  const server = JSON.parse(readFileSync(join(f.home, "servers.json"), "utf8")).fake;
  const { mkdirSync } = await import("node:fs");
  mkdirSync(join(f.home, "cache"), { recursive: true });
  writeFileSync(join(f.home, "cache", "fake.json"), JSON.stringify({ key: keyOf(server), at: "now", tools: [{ name: "echo", inputSchema: { type: "object" } }] }));
  const client = await f.connect();
  const r = await client.callTool({ name: "fake__echo", arguments: { text: "x" } });
  assert.equal(r.isError, true);
  assert.match(text(r), /ONDEMAND_TEST_UNSET_VAR is not set/);
  await client.close();
});

// Write a cache by hand, so a server's tools are listed without starting it.
async function seedCache(home, name) {
  const { keyOf } = await import("../src/config.mjs");
  const { mkdirSync } = await import("node:fs");
  const server = JSON.parse(readFileSync(join(home, "servers.json"), "utf8"))[name];
  mkdirSync(join(home, "cache"), { recursive: true });
  writeFileSync(join(home, "cache", `${name}.json`), JSON.stringify({ key: keyOf(server), at: "now", tools: [{ name: "echo", inputSchema: { type: "object" } }] }));
}

test("a server that will not start is retried with backoff, not on every call", async () => {
  const f = setup({ env: { FAKE_LOG: "", FAKE_FAIL: "1" } });
  const servers = JSON.parse(readFileSync(join(f.home, "servers.json"), "utf8"));
  servers.fake.env.FAKE_LOG = join(f.home, "fake.log");
  writeFileSync(join(f.home, "servers.json"), JSON.stringify(servers));
  await seedCache(f.home, "fake");
  const client = await f.connect();
  try {
    const first = await client.callTool({ name: "fake__echo", arguments: { text: "x" } });
    assert.equal(first.isError, true);
    assert.equal(f.starts(), 1);
    const second = await client.callTool({ name: "fake__echo", arguments: { text: "x" } });
    assert.match(text(second), /failed to start 1 time\(s\); next try in \d+s/);
    assert.equal(f.starts(), 1, "no new attempt during the backoff");
    // ondemand_restart retries at once.
    await client.callTool({ name: "ondemand_restart", arguments: { server: "fake" } });
    await client.callTool({ name: "fake__echo", arguments: { text: "x" } });
    assert.equal(f.starts(), 2);
  } finally {
    await client.close();
  }
});

test("memory limits: a server over maxMemory, or over the shared budget, is stopped", async () => {
  for (const [label, extra, settings] of [["maxMemory", { maxMemory: 1 }, null], ["memoryBudget", {}, { memoryBudget: 1 }]]) {
    const f = setup({ idle: 600, ...extra }, { MCP_ONDEMAND_WATCHDOG: "1" });
    if (settings) writeFileSync(join(f.home, "settings.json"), JSON.stringify(settings));
    const client = await f.warm();
    try {
      await client.callTool({ name: "fake__echo", arguments: { text: "x" } });
      const p = f.pid(1);
      assert.ok(await until(() => !alive(p), 20000), `${label}: stopped though not idle`);
      assert.match(readFileSync(join(f.home, "ondemand.log"), "utf8"), label === "maxMemory" ? /over its limit of 1 MB/ : /memory budget/);
    } finally {
      await client.close();
    }
  }
});

test("a server added to servers.json shows up in an open session", async () => {
  const f = setup();
  const client = await f.warm();
  try {
    let notified = false;
    const { ToolListChangedNotificationSchema } = await import("@modelcontextprotocol/sdk/types.js");
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      notified = true;
    });
    const servers = JSON.parse(readFileSync(join(f.home, "servers.json"), "utf8"));
    servers.extra = { ...servers.fake };
    writeFileSync(join(f.home, "servers.json"), JSON.stringify(servers));
    await seedCache(f.home, "extra");
    assert.ok(await until(() => notified), "client told the tools changed");
    assert.ok((await client.listTools()).tools.some((t) => t.name === "extra__echo"));
  } finally {
    await client.close();
  }
});
