#!/usr/bin/env node
// mcp-ondemand: run MCP servers only while they are used.
import { importServers, restoreServers } from "../src/claude-config.mjs";
import { DEFAULT_IDLE, HOME, loadServers, readCache } from "../src/config.mjs";
import { refresh, serve } from "../src/proxy.mjs";

const HELP = `mcp-ondemand: MCP servers that only run while they are used.

  mcp-ondemand                     run as the MCP server (what Claude Code starts)
  mcp-ondemand import [options]    move local MCP servers from ~/.claude.json behind mcp-ondemand
      --project <dir>              take that project's servers instead of the user-level ones
      --only a,b  --except a,b     pick servers
      --dry-run                    show what would move, change nothing
  mcp-ondemand refresh [name]      start servers once to rebuild their cached tool lists
  mcp-ondemand status              show configured servers and their cache
  mcp-ondemand restore [--only a,b]  put servers back into ~/.claude.json

Files live in ${HOME} (set MCP_ONDEMAND_HOME to move them).`;

const [cmd, ...rest] = process.argv.slice(2);
const flag = (name) => {
  const i = rest.indexOf(`--${name}`);
  return i < 0 ? undefined : rest[i + 1];
};
const list = (name) => flag(name)?.split(",").map((s) => s.trim()).filter(Boolean);

switch (cmd) {
  case undefined:
  case "serve":
    await serve();
    break;
  case "import": {
    const r = importServers({ project: flag("project"), only: list("only"), except: list("except"), dryRun: rest.includes("--dry-run") });
    console.log(`${r.moved.length ? `Moved from ${r.scope}: ${r.moved.join(", ")}` : `Nothing to move from ${r.scope}.`}`);
    if (r.skipped.length) console.log(`Left in place (remote or not selected): ${r.skipped.join(", ")}`);
    if (rest.includes("--dry-run")) break;
    console.log(`Backup of the old config: ${r.backup}`);
    console.log("Building tool caches...");
    const failed = await refresh(r.moved);
    console.log(failed ? `\n${failed} server(s) failed to start. They stay configured; fix them and run: mcp-ondemand refresh <name>` : "\nDone. Restart Claude Code to use it.");
    process.exit(0);
  }
  case "refresh":
    process.exit((await refresh(rest[0] ? [rest[0]] : undefined)) ? 1 : 0);
  case "status": {
    const servers = loadServers();
    if (!Object.keys(servers).length) console.log(`No servers configured. Run: mcp-ondemand import`);
    for (const [name, s] of Object.entries(servers)) {
      const c = readCache(name, s);
      console.log(`${name}: ${c ? `${c.tools.length} tools, cached ${c.at}` : "no cache (run: mcp-ondemand refresh " + name + ")"}; idle ${s.idle ?? DEFAULT_IDLE}s${s.preload ? ", preload" : ""}`);
    }
    break;
  }
  case "restore": {
    const r = restoreServers({ only: list("only") });
    console.log(`Restored: ${r.restored.join(", ") || "nothing"}\nBackup of the old config: ${r.backup}\nRestart Claude Code to use it.`);
    break;
  }
  case "help":
  case "--help":
  case "-h":
    console.log(HELP);
    break;
  default:
    console.error(`Unknown command ${cmd}\n\n${HELP}`);
    process.exit(1);
}
