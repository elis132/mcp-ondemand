// Measures what MCP servers cost while they run, and what mcp-ondemand itself costs, on this machine.
//
//   node bench/measure.mjs                 popular servers (downloaded by npx on first run)
//   node bench/measure.mjs servers.json    your own servers, in mcp-ondemand's format
//
// Memory is resident memory of each server's whole process tree (launcher included), a few seconds after start.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const home = mkdtempSync(join(tmpdir(), "mcp-ondemand-bench-"));
process.env.MCP_ONDEMAND_HOME = home;
const npx = (pkg, ...args) => ({ command: "npx", args: ["-y", pkg, ...args] });
const servers = process.argv[2]
  ? JSON.parse(readFileSync(process.argv[2], "utf8"))
  : {
      playwright: npx("@playwright/mcp@latest"),
      github: { ...npx("@modelcontextprotocol/server-github"), env: { GITHUB_PERSONAL_ACCESS_TOKEN: "unused" } },
      filesystem: npx("@modelcontextprotocol/server-filesystem", home),
      memory: npx("@modelcontextprotocol/server-memory"),
      "sequential-thinking": npx("@modelcontextprotocol/server-sequential-thinking"),
      context7: npx("@upstash/context7-mcp"),
    };
writeFileSync(join(home, "servers.json"), JSON.stringify(servers));

const { ensureHome } = await import("../src/config.mjs");
ensureHome();
const { Hub } = await import("../src/proxy.mjs");
const { processTable, treeMemory } = await import("../src/kill.mjs");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const rows = [];
const hub = new Hub(servers);
// First start of each, unmeasured: npx downloads the package once.
for (const name of Object.keys(servers)) await hub.start(name).then(() => hub.stop(name, "warm"), () => {});
for (const name of Object.keys(servers)) {
  const t = Date.now();
  try {
    const s = await hub.start(name);
    const ms = Date.now() - t;
    await sleep(3000);
    rows.push({ name, mb: treeMemory(s.pid, await processTable()), ms, tools: hub.cache(name)?.tools?.length ?? 0 });
  } catch (err) {
    rows.push({ name, error: String(err?.message ?? err).slice(0, 60) });
  }
  await hub.stop(name, "measured");
}

// mcp-ondemand's own cost: one session pipe and the daemon, with nothing running behind them.
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
const transport = new StdioClientTransport({ command: process.execPath, args: [join(root, "bin", "mcp-ondemand.mjs")], env: { ...process.env, MCP_ONDEMAND_HOME: home, MCP_ONDEMAND_LINGER: "1" } });
const client = new Client({ name: "bench", version: "1" });
await client.connect(transport);
await client.listTools();
await sleep(3000);
const table = await processTable();
const daemon = Number(readFileSync(join(home, "daemon.pid"), "utf8"));
const pipeMb = treeMemory(transport.pid, table);
const daemonMb = treeMemory(daemon, table);
await client.close();

const ok = rows.filter((r) => r.mb !== undefined);
const total = ok.reduce((sum, r) => sum + r.mb, 0);
console.log(`| Server | Memory while running | Start time | Tools |\n| --- | ---: | ---: | ---: |`);
for (const r of rows) console.log(r.error ? `| ${r.name} | failed: ${r.error} | | |` : `| ${r.name} | ${r.mb} MB | ${(r.ms / 1000).toFixed(1)} s | ${r.tools} |`);
console.log(`| **All ${ok.length} together** | **${total} MB** | | |`);
console.log(`\nmcp-ondemand itself: ${pipeMb} MB per session, ${daemonMb} MB for the daemon (once).`);
console.log(`\n| Open sessions | Without mcp-ondemand | With it, nothing in use | With it, two servers in use |\n| ---: | ---: | ---: | ---: |`);
const two = ok.map((r) => r.mb).sort((a, b) => b - a).slice(0, 2).reduce((a, b) => a + b, 0);
for (const n of [1, 3, 5]) console.log(`| ${n} | ${n * total} MB | ${n * pipeMb + daemonMb} MB | ${n * pipeMb + daemonMb + two} MB |`);
process.exit(0);
