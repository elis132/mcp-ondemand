#!/usr/bin/env node
// mcp-ondemand: run MCP servers only while they are used.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { clientHome, detectClient } from "../src/client.mjs";
const [cmd, ...rest] = process.argv.slice(2);
const flag = (name) => {
  const i = rest.indexOf(`--${name}`);
  if (i < 0) return undefined;
  if (!rest[i + 1] || rest[i + 1].startsWith("--")) throw new Error(`--${name} requires a value`);
  return rest[i + 1];
};
// import, restore and doctor edit or read a client's config. The others only need the data folder, so an explicit
// MCP_ONDEMAND_HOME is enough for them.
const management = ["import", "restore", "doctor"].includes(cmd) || (["refresh", "status", "stop", "bench"].includes(cmd) && !process.env.MCP_ONDEMAND_HOME);
let client = "claude";
try {
  if (management || flag("client") || process.env.MCP_ONDEMAND_CLIENT) client = detectClient({ client: flag("client") });
} catch (err) {
  console.error(err.message); process.exit(1);
}
process.env.MCP_ONDEMAND_HOME ??= clientHome(client);
const { CLAUDE_JSON, ENTRY, importPlugins, pluginServers, ...claudeConfig } = await import("../src/claude-config.mjs");
const clientConfig = client === "codex" ? await import("../src/codex-config.mjs") : claudeConfig;
const { importServers, restoreServers } = clientConfig;
const { DEFAULT_IDLE, expand, HOME, loadServers, readCache, SERVERS } = await import("../src/config.mjs");
const { VERSION } = await import("../src/build.mjs");
const { daemonPid, launchDaemon, serve } = await import("../src/session.mjs");
const clientLabel = client === "codex" ? "Codex" : "Claude Code";
// The MCP SDK is loaded only by the commands that need it: "serve" in shared mode is a plain pipe and stays small.
const refresh = async (...args) => (await import("../src/proxy.mjs")).refresh(...args);
const daemon = () => import("../src/daemon.mjs");

const HELP = `mcp-ondemand ${VERSION}: MCP servers that only run while they are used.

  mcp-ondemand                     run as the MCP server (what your client starts)
  mcp-ondemand import [options]    move local MCP servers behind mcp-ondemand
      --client claude|codex         select a client (otherwise detected from the session or installed config)
      --plugins                    move the MCP servers of enabled Claude Code plugins instead, and switch those plugins off
      --project <dir>              take that project's servers instead of the user-level ones
      --only a,b  --except a,b     pick servers (or plugins, with --plugins)
      --dry-run                    show what would move, change nothing
  mcp-ondemand refresh [name]      start servers once to rebuild their cache
  mcp-ondemand status              configured servers, their cache, and the shared daemon
  mcp-ondemand stop                stop the shared daemon and every server it runs
  mcp-ondemand bench [servers.json]  measure what servers cost and what mcp-ondemand saves
                                   (popular servers by default; pass ~/.mcp-ondemand/servers.json for yours)
  mcp-ondemand doctor              check the setup and say what is wrong
  mcp-ondemand restore [--only a,b]  put servers back where they came from

Sessions share one daemon, so they share servers (perSession servers excepted).
MCP_ONDEMAND_SHARED=0 runs each session on its own instead.
Files live in ${HOME} (set MCP_ONDEMAND_HOME to move them).`;

const list = (name) => flag(name)?.split(",").map((s) => s.trim()).filter(Boolean);
const dryRun = rest.includes("--dry-run");

async function finishImport(r, what) {
  console.log(r.moved.length ? `Moved ${what}: ${r.moved.join(", ")}` : `Nothing to move ${what}.`);
  if (r.skipped.length) console.log(`Left in place (remote, disabled, native, unsupported, or not selected): ${r.skipped.join(", ")}`);
  if (r.plugins?.length) console.log(`${dryRun ? "Would switch off" : "Switched off"} plugins: ${r.plugins.join(", ")}`);
  if (dryRun || !r.moved.length) return;
  for (const b of [r.backup, r.settingsBackup].filter(Boolean)) console.log(`Backup: ${b}`);
  console.log("Building caches...");
  const failed = await refresh(r.moved);
  console.log(failed ? `\n${failed} server(s) failed to start. They stay configured: run "mcp-ondemand doctor --client ${client}", fix them, then "mcp-ondemand refresh <name> --client ${client}".` : `\nDone. Restart ${clientLabel} to use it.`);
}

function onPath(command) {
  if (existsSync(command)) return true;
  const finder = process.platform === "win32" ? "where" : "which";
  return spawnSync(finder, [command], { stdio: "ignore", windowsHide: true }).status === 0;
}

function doctor() {
  let problems = 0;
  const ok = (msg) => console.log(`  ok    ${msg}`);
  const bad = (msg, fix) => {
    problems++;
    console.log(`  FIX   ${msg}${fix ? `\n        ${fix}` : ""}`);
  };
  console.log(`mcp-ondemand ${VERSION}, files in ${HOME}\n`);
  const major = Number(process.versions.node.split(".")[0]);
  major >= 20 ? ok(`Node.js ${process.versions.node}`) : bad(`Node.js ${process.versions.node} is too old`, "Install Node.js 20 or newer.");

  let config = {};
  const file = client === "codex" ? clientConfig.configPath({ project: flag("project") }) : CLAUDE_JSON;
  try {
    config = client === "codex" ? clientConfig.readConfig({ project: flag("project") }) : JSON.parse(readFileSync(file, "utf8"));
  } catch {
    bad(`Cannot read ${file}`, `Is ${clientLabel} installed and started at least once?`);
  }
  const configured = client === "codex" ? config.mcp_servers : config.mcpServers;
  const entry = configured?.[ENTRY];
  if (!entry) bad(`"${ENTRY}" is not registered in ${file}`, `Run "mcp-ondemand import --client ${client}".`);
  else if (!entry.args?.[0] || !existsSync(entry.args[0])) bad(`"${ENTRY}" points at ${entry.args?.[0]}, which does not exist`, 'Run "mcp-ondemand import" again from where mcp-ondemand now lives.');
  else if (entry.enabled === false) bad(`"${ENTRY}" is disabled in ${file}`);
  else ok(`"${ENTRY}" is registered with ${clientLabel}`);

  const alwaysOn = Object.entries(configured ?? {}).filter(([name, s]) => name !== ENTRY && !["node_repl", "cua_repl"].includes(name) && s.enabled !== false && (s.type ?? "stdio") === "stdio" && s.command).map(([n]) => n);
  if (alwaysOn.length) bad(`Still always-on in ${file}: ${alwaysOn.join(", ")}`, `Run "mcp-ondemand import --client ${client}"; entries with unsupported settings stay in place.`);
  const plugins = client === "claude" ? pluginServers().filter((p) => (p.server.type ?? "stdio") === "stdio" && p.server.command) : [];
  if (plugins.length) bad(`Plugins still running their own MCP servers: ${[...new Set(plugins.map((p) => p.plugin))].join(", ")}`, 'Run "mcp-ondemand import --plugins".');

  let servers = {};
  try {
    servers = loadServers();
  } catch (err) {
    bad(`${SERVERS} is not valid JSON: ${err.message}`);
  }
  if (!Object.keys(servers).length) bad("No servers configured", 'Run "mcp-ondemand import".');
  for (const [name, s] of Object.entries(servers)) {
    let def;
    try {
      def = expand(s);
    } catch (err) {
      bad(`${name}: ${err.message}`, "Set it in your environment, or give a fallback: ${NAME:-value}.");
      continue;
    }
    if (!onPath(def.command)) {
      bad(`${name}: command "${def.command}" not found`, "Install it, or use its full path in servers.json.");
      continue;
    }
    const c = readCache(name, s);
    if (!c) bad(`${name}: no cache`, `Run "mcp-ondemand refresh ${name}". If it fails, run the command by hand to see its error. For npx: "npm cache verify" fixes a broken npm cache.`);
    else ok(`${name}: ${c.tools?.length ?? 0} tools, idle ${s.idle ?? DEFAULT_IDLE}s${s.preload ? ", preload" : ""}`);
  }
  console.log(problems ? `\n${problems} thing(s) to fix.` : "\nAll good.");
  return problems;
}

switch (cmd) {
  case undefined:
  case "serve":
    await serve();
    break;
  case "import":
    if (rest.includes("--plugins") && client !== "claude") throw new Error("--plugins currently supports Claude Code only; Codex plugin-managed servers are left in place.");
    if (rest.includes("--plugins")) await finishImport(importPlugins({ only: list("only"), except: list("except"), dryRun }), "from plugins");
    else {
      const r = importServers({ project: flag("project"), only: list("only"), except: list("except"), dryRun });
      await finishImport(r, `from ${r.scope}`);
    }
    process.exit(0);
  case "refresh":
    process.exit((await refresh(rest[0] && !rest[0].startsWith("--") ? [rest[0]] : undefined)) ? 1 : 0);
  case "status": {
    const pid = daemonPid();
    const live = pid ? await (await daemon()).liveStatus() : null;
    if (live) {
      console.log(`Shared daemon running, pid ${pid}:\n`);
      for (const l of live) console.log(`  ${l}`);
      break;
    }
    console.log(pid ? `Shared daemon running, pid ${pid}, but it did not answer.\n` : "Shared daemon not running (it starts with the first session).\n");
    const servers = loadServers();
    if (!Object.keys(servers).length) console.log("No servers configured. Run: mcp-ondemand import");
    for (const [name, s] of Object.entries(servers)) {
      const c = readCache(name, s);
      console.log(`${name}: ${c ? `${c.tools?.length ?? 0} tools, cached ${c.at}` : `no cache (run: mcp-ondemand refresh ${name})`}; idle ${s.idle ?? DEFAULT_IDLE}s${s.preload ? ", preload" : ""}${s.perSession ? ", per session" : ""}${s.from?.startsWith("plugin:") ? `, from ${s.from}` : ""}`);
    }
    break;
  }
  case "daemon":
    await (await daemon()).runDaemon();
    break;
  case "daemon-launch":
    launchDaemon();
    process.exit(0);
  case "stop": {
    const pid = (await daemon()).stopDaemon();
    console.log(pid ? `Stopped the daemon (pid ${pid}) and its servers. Open sessions reconnect on their next start.` : "No daemon running.");
    break;
  }
  case "doctor":
    process.exit(doctor() ? 1 : 0);
  case "restore": {
    const r = restoreServers({ only: list("only"), project: flag("project") });
    console.log(`Restored: ${r.restored.join(", ") || "nothing"}`);
    if (r.plugins.length) console.log(`Switched plugins back on: ${r.plugins.join(", ")}`);
    if (r.backup) console.log(`Backup of the old config: ${r.backup}`);
    console.log(`Restart ${clientLabel} to use it.`);
    break;
  }
  case "bench": {
    const { spawnSync: run } = await import("node:child_process");
    const script = new URL("../bench/measure.mjs", import.meta.url);
    process.exit(run(process.execPath, [fileURLToPath(script), ...rest], { stdio: "inherit" }).status ?? 1);
  }
  case "--version":
  case "-v":
    console.log(VERSION);
    break;
  case "help":
  case "--help":
  case "-h":
    console.log(HELP);
    break;
  default:
    console.error(`Unknown command ${cmd}\n\n${HELP}`);
    process.exit(1);
}
