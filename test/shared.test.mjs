// Shared mode: two sessions, one daemon. Shared servers run once, perSession servers once per session.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const home = mkdtempSync(join(tmpdir(), "mcp-ondemand-shared-"));
process.env.MCP_ONDEMAND_HOME = home;
const { SOCKET } = await import("../src/socket.mjs");

const fake = join(root, "test", "fake-server.mjs");
const sharedLog = join(home, "shared.log");
const ownLog = join(home, "own.log");
writeFileSync(join(home, "servers.json"), JSON.stringify({
  shared: { command: process.execPath, args: [fake], env: { FAKE_LOG: sharedLog }, idle: 2 },
  own: { command: process.execPath, args: [fake], env: { FAKE_LOG: ownLog }, idle: 60, perSession: true },
}));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (check, ms = 10000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) if (await check()) return true;
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
const starts = (file) => (existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter((l) => l.startsWith("start")).map((l) => Number(l.split(" ")[1])) : []);
const text = (r) => r.content[0].text;
const daemonPid = () => (existsSync(join(home, "daemon.pid")) ? Number(readFileSync(join(home, "daemon.pid"), "utf8")) : null);
// Windows may hand out paths with a long-path prefix (\\?\C:\...); compare without it.
const norm = (p) => p.replaceAll("\\", "/").replace(/^\/\/\?\//, "").toLowerCase();

async function session(cwd) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(root, "bin", "mcp-ondemand.mjs")],
    env: { ...process.env, MCP_ONDEMAND_HOME: home, MCP_ONDEMAND_LINGER: "1" },
    cwd,
  });
  const client = new Client({ name: "test", version: "1" });
  await client.connect(transport);
  return client;
}

// A raw hello as a session of another version would send it.
function hello(version) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(SOCKET, () => socket.write(`${JSON.stringify({ ondemand: { version, cwd: home } })}\n`));
    let buf = "";
    socket.on("data", (d) => (buf += d));
    socket.on("close", () => resolve(buf.trim()));
    socket.on("error", reject);
  });
}

test("sessions share servers through one daemon, which leaves when they are gone", async () => {
  const dirA = mkdirSync(join(home, "project-a"), { recursive: true }) ?? join(home, "project-a");
  const dirB = mkdirSync(join(home, "project-b"), { recursive: true }) ?? join(home, "project-b");

  // The first session starts the daemon, which builds both caches in the background.
  const a = await session(dirA);
  assert.ok(await until(() => existsSync(join(home, "cache", "shared.json")) && existsSync(join(home, "cache", "own.json"))), "caches built");
  assert.ok(await until(() => starts(sharedLog).every((p) => !alive(p)) && starts(ownLog).every((p) => !alive(p))), "cache-building servers stopped");
  const daemon = daemonPid();
  assert.ok(daemon && alive(daemon), "daemon running");
  const b = await session(dirB);
  try {
    // Fresh session: the tools appear after the daemon has learned them, so list again from b.
    const names = (await b.listTools()).tools.map((t) => t.name);
    assert.ok(names.includes("shared__echo") && names.includes("own__echo"));

    // Shared: both sessions use one copy.
    const before = starts(sharedLog).length;
    assert.equal(text(await a.callTool({ name: "shared__echo", arguments: { text: "a" } })), "echo:a");
    assert.equal(text(await b.callTool({ name: "shared__echo", arguments: { text: "b" } })), "echo:b");
    assert.equal(starts(sharedLog).length, before + 1, "one shared copy for two sessions");

    // perSession: one copy each, started in that session's folder.
    const ownBefore = starts(ownLog).length;
    const cwdA = text(await a.callTool({ name: "own__cwd", arguments: {} }));
    assert.equal(norm(cwdA), norm(dirA));
    assert.equal(norm(text(await b.callTool({ name: "own__cwd", arguments: {} }))), norm(dirB));
    assert.equal(starts(ownLog).length, ownBefore + 2, "one copy per session");
    const [ownA, ownB] = starts(ownLog).slice(-2);

    // Session a ends: its own copy goes, the shared one stays for b.
    await a.close();
    assert.ok(await until(() => !alive(ownA)), "a's perSession server stopped with a");
    assert.ok(alive(ownB));
    assert.equal(text(await b.callTool({ name: "shared__echo", arguments: { text: "c" } })), "echo:c");

    // A session of another version is turned away, and this daemon stops taking new sessions.
    assert.match(await hello("0.0.0-other"), /"restart"/);
  } finally {
    await a.close().catch(() => {});
    await b.close();
  }

  // Everyone has gone: the daemon stops its servers and exits.
  assert.ok(await until(() => !alive(daemon), 15000), "daemon exited");
  assert.ok(starts(sharedLog).every((p) => !alive(p)) && starts(ownLog).every((p) => !alive(p)), "no server left running");
  assert.ok(!existsSync(join(home, "daemon.pid")));
});
