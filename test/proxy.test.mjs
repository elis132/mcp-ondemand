// mcp-ondemand against a fake server: lazy start, cache, shared start, idle stop, crash restart, cleanup on exit.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const home = mkdtempSync(join(tmpdir(), "mcp-ondemand-"));
const fakeLog = join(home, "fake.log");
writeFileSync(join(home, "servers.json"), JSON.stringify({
  fake: { command: process.execPath, args: [join(root, "test", "fake-server.mjs")], env: { FAKE_LOG: fakeLog }, idle: 2 },
}));

const lines = () => (existsSync(fakeLog) ? readFileSync(fakeLog, "utf8").trim().split("\n") : []);
const starts = () => lines().length;
const pid = (i) => Number(lines()[i].split(" ")[1]);
const alive = (p) => {
  try {
    process.kill(p, 0);
    return true;
  } catch {
    return false;
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (check, ms = 5000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) if (check()) return true;
  return check();
};
const text = (r) => r.content[0].text;

async function connect() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(root, "bin", "mcp-ondemand.mjs")],
    env: { ...process.env, MCP_ONDEMAND_HOME: home },
    cwd: root,
  });
  const client = new Client({ name: "test", version: "1" });
  await client.connect(transport);
  return client;
}

test("servers start on first use, stop when idle, and never outlive the session", async () => {
  // Cold cache: the proxy learns the tools once in the background, then stops the server.
  let client = await connect();
  assert.ok(await until(() => existsSync(join(home, "cache", "fake.json")) && starts() === 1 && !alive(pid(0))), "cache built and server stopped");
  await client.close();

  // Warm cache: tools and instructions come from the cache, nothing is started.
  client = await connect();
  const names = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["fake__crash", "fake__echo", "fake__slow", "ondemand_restart", "ondemand_status"]);
  assert.match(client.getInstructions(), /Fake server instructions/);
  await sleep(300);
  assert.equal(starts(), 1, "listing tools starts nothing");

  // Two first calls at once share one start.
  const [a, b] = await Promise.all([
    client.callTool({ name: "fake__echo", arguments: { text: "a" } }),
    client.callTool({ name: "fake__echo", arguments: { text: "b" } }),
  ]);
  assert.deepEqual([text(a), text(b)], ["echo:a", "echo:b"]);
  assert.equal(starts(), 2);
  assert.match(text(await client.callTool({ name: "ondemand_status", arguments: {} })), /fake: running/);

  // A call longer than the idle time is not cut off.
  assert.equal(text(await client.callTool({ name: "fake__slow", arguments: { ms: 3000 } })), "done");
  assert.equal(starts(), 2);

  // Idle for 2 s: stopped. The next call starts it again.
  assert.ok(await until(() => !alive(pid(1))), "idle server stopped");
  assert.equal(text(await client.callTool({ name: "fake__echo", arguments: { text: "c" } })), "echo:c");
  assert.equal(starts(), 3);

  // A crash is reported, and the next call gets a fresh server.
  assert.equal((await client.callTool({ name: "fake__crash", arguments: {} })).isError, true);
  await sleep(300);
  assert.equal(text(await client.callTool({ name: "fake__echo", arguments: { text: "d" } })), "echo:d");
  assert.equal(starts(), 4);

  // ondemand_restart stops it on request.
  await client.callTool({ name: "ondemand_restart", arguments: { server: "fake" } });
  assert.ok(await until(() => !alive(pid(3))));

  // The session ends: nothing is left running.
  await client.callTool({ name: "fake__echo", arguments: { text: "e" } });
  const last = pid(4);
  assert.ok(alive(last));
  await client.close();
  assert.ok(await until(() => !alive(last)), "server killed when the session ended");
});
