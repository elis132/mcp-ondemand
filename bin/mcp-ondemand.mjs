#!/usr/bin/env node
// mcp-ondemand: run MCP servers only while they are used.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { CLAUDE_JSON, ENTRY, importPlugins, importServers, pluginServers, restoreServers } from "../src/claude-config.mjs";
import { DEFAULT_IDLE, expand, HOME, loadServers, readCache, SERVERS } from "../src/config.mjs";
import { daemonPid, launchDaemon, liveStatus, runDaemon, serve, stopDaemon } from "../src/daemon.mjs";
import { refresh, VERSION } from "../src/proxy.mjs";

const HELP = `mcp-ondemand ${VERSION}: MCP servers that only run while they are used.

  mcp-ondemand                     run as the MCP server (what Claude Code starts)
  mcp-ondemand import [options]    move local MCP servers from ~/.claude.json behind mcp-ondemand
      --plugins                    move the MCP servers of enabled Claude Code plugins instead, and switch those plugins off
      --project <dir>              take that project's servers instead of the user-level ones
      --only a,b  --except a,b     pick servers (or plugins, with --plugins)
      --dry-run                    show what would move, change nothing
  mcp-ondemand refresh [name]      start servers once to rebuild their cache
  mcp-ondemand status              configured servers, their cache, and the shared daemon
  mcp-ondemand stop                stop the shared daemon and every server it runs
  mcp-ondemand doctor              check the setup and say what is wrong
  mcp-ondemand restore [--only a,b]  put servers back where they came from

Sessions share one daemon, so they share servers (perSession servers excepted).
MCP_ONDEMAND_SHARED=0 runs each session on its own instead.
Files live in ${HOME} (set MCP_ONDEMAND_HOME to move them).`;

const [cmd, ...rest] = process.argv.slice(2);
const flag = (name) => {
  const i = rest.indexOf(`--${name}`);
  return i < 0 ? undefined : rest[i + 1];
};
const list = (name) => flag(name)?.split(",").map((s) => s.trim()).filter(Boolean);
const dryRun = rest.includes("--dry-run");

async function finishImport(r, what) {
  console.log(r.moved.length ? `Moved ${what}: ${r.moved.join(", ")}` : `Nothing to move ${what}.`);
  if (r.skipped.length) console.log(`Left in place (remote, or not selected): ${r.skipped.join(", ")}`);
  if (r.plugins?.length) console.log(`${dryRun ? "Would switch off" : "Switched off"} plugins: ${r.plugins.join(", ")}`);
  if (dryRun || !r.moved.length) return;
  for (const b of [r.backup, r.settingsBackup].filter(Boolean)) console.log(`Backup: ${b}`);
  console.log("Building caches...");
  const failed = await refresh(r.moved);
  console.log(failed ? `\n${failed} server(s) failed to start. They stay configured: run "mcp-ondemand doctor", fix them, then "mcp-ondemand refresh <name>".` : "\nDone. Restart Claude Code to use it.");
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

  let claude = {};
  try {
    claude = JSON.parse(readFileSync(CLAUDE_JSON, "utf8"));
  } catch {
    bad(`Cannot read ${CLAUDE_JSON}`, "Is Claude Code installed and started at least once?");
  }
  const entry = claude.mcpServers?.[ENTRY];
  if (!entry) bad(`"${ENTRY}" is not registered in ${CLAUDE_JSON}`, 'Run "mcp-ondemand import".');
  else if (!entry.args?.[0] || !existsSync(entry.args[0])) bad(`"${ENTRY}" points at ${entry.args?.[0]}, which does not exist`, 'Run "mcp-ondemand import" again from where mcp-ondemand now lives.');
  else ok(`"${ENTRY}" is registered with Claude Code`);

  const alwaysOn = Object.entries(claude.mcpServers ?? {}).filter(([name, s]) => name !== ENTRY && (s.type ?? "stdio") === "stdio" && s.command).map(([n]) => n);
  if (alwaysOn.length) bad(`Still always-on in ${CLAUDE_JSON}: ${alwaysOn.join(", ")}`, 'Run "mcp-ondemand import".');
  const plugins = pluginServers().filter((p) => (p.server.type ?? "stdio") === "stdio" && p.server.command);
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
    if (rest.includes("--plugins")) await finishImport(importPlugins({ only: list("only"), except: list("except"), dryRun }), "from plugins");
    else {
      const r = importServers({ project: flag("project"), only: list("only"), except: list("except"), dryRun });
      await finishImport(r, `from ${r.scope}`);
    }
    process.exit(0);
  case "refresh":
    process.exit((await refresh(rest[0] ? [rest[0]] : undefined)) ? 1 : 0);
  case "status": {
    const pid = daemonPid();
    const live = pid ? await liveStatus() : null;
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
    await runDaemon();
    break;
  case "daemon-launch":
    launchDaemon();
    process.exit(0);
  case "stop": {
    const pid = stopDaemon();
    console.log(pid ? `Stopped the daemon (pid ${pid}) and its servers. Open sessions reconnect on their next start.` : "No daemon running.");
    break;
  }
  case "doctor":
    process.exit(doctor() ? 1 : 0);
  case "restore": {
    const r = restoreServers({ only: list("only") });
    console.log(`Restored: ${r.restored.join(", ") || "nothing"}`);
    if (r.plugins.length) console.log(`Switched plugins back on: ${r.plugins.join(", ")}`);
    console.log(`Backup of the old config: ${r.backup}\nRestart Claude Code to use it.`);
    break;
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
