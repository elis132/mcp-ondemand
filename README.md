# mcp-ondemand

**MCP servers that only run while they are used.**

Claude Code starts every configured MCP server when a session opens, keeps all of them running for the whole
session, and with several sessions open you get several copies of each. Ten servers and four sessions is forty
processes, most of them never called. Some are left behind after their session ends.

mcp-ondemand is one small MCP server that sits in front of all the others:

- **Claude sees every real tool at once**, answered from a cache on disk. Nothing else is started.
- **A server starts on its first tool call**, and stops after it has been idle for a while (10 minutes by default).
  A call that is still running is never cut off.
- **Sessions share servers.** Five Claude sessions using the same server run one copy of it, not five. Servers that
  hold state, like a browser, can be kept per session instead.
- **Nothing is left behind.** Idle servers are stopped, a session's own servers die with it, and the whole process
  tree goes, including the children that launchers like `npx`, `uvx`, `cmd` and `wsl` start.
- **Your tools keep their real names and schemas**, so Claude Code's per-tool permissions keep working. No
  meta-tools, no extra round trips to find a tool.
- **Prompts and resources pass through too**, and so do progress reports and cancellation: press Esc and the call
  stops on the real server, not just in Claude.
- **Plugin MCP servers too:** `import --plugins` moves the servers of your Claude Code plugins behind it.

```
Claude session 1 ─┐                      ┌── github       (running, shared)
Claude session 2 ─┼── mcp-ondemand ──────┼── playwright   (one per session)
Claude session 3 ─┘     daemon           └── ...          (stopped)
```

## Install

Needs Node.js 20 or newer.

```bash
git clone https://github.com/elis132/mcp-ondemand.git ~/mcp-ondemand
cd ~/mcp-ondemand && npm install
node bin/mcp-ondemand.mjs import
```

`import` moves the local (stdio) MCP servers from your user-level Claude Code config (`~/.claude.json`) behind
mcp-ondemand, puts one `ondemand` server in their place, backs up the old config, and starts each server once to
build its tool cache. Remote (HTTP/SSE) servers have no local process and are left where they are.

Servers that come from Claude Code plugins (Playwright, for example) are moved separately:

```bash
node bin/mcp-ondemand.mjs import --plugins
```

That switches those plugins off, so they stop starting their own copy. Restart Claude Code. `claude mcp list` should
show `ondemand` as connected, and `node bin/mcp-ondemand.mjs doctor` checks the whole setup.

**Or let your agent do it:** paste [SETUP_PROMPT.md](SETUP_PROMPT.md) into Claude Code, Codex or similar.

## Use

Tools are named `<server>__<tool>`, so in Claude Code they appear as `mcp__ondemand__github__create_issue`.
Two tools of its own:

| Tool | Does |
| --- | --- |
| `ondemand_status` | Which servers are running, their process ids and memory (whole process tree), calls made, the last start error |
| `ondemand_restart` | Stop a server that hangs. It starts again on its next call |

Each server's own instructions are passed on to Claude. Prompts are named `<server>__<prompt>` like tools;
resources keep their own URIs.

## Commands

```bash
mcp-ondemand import [--project <dir>] [--only a,b] [--except a,b] [--dry-run]
mcp-ondemand import --plugins [--only a,b] [--dry-run]   # servers from Claude Code plugins
mcp-ondemand refresh [name]        # start servers once to rebuild their cache
mcp-ondemand status                # configured servers and their cache
mcp-ondemand doctor                # check the setup and say what to fix
mcp-ondemand stop                  # stop the shared daemon and every server it runs
mcp-ondemand restore [--only a,b]  # put servers back where they came from
```

(`node bin/mcp-ondemand.mjs <command>` if it is not on your PATH, or `npm link` once in the repo.)

## Configure

Everything lives in `~/.mcp-ondemand/` (set `MCP_ONDEMAND_HOME` to move it): `servers.json`, the tool `cache/`,
`backups/` of your Claude config, and `ondemand.log`.

`servers.json` uses the same shape as Claude Code's `mcpServers`, plus a few optional fields:

```json
{
  "playwright": {
    "command": "npx",
    "args": ["-y", "@playwright/mcp@latest"],
    "idle": 1800
  },
  "github": {
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-github"],
    "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "..." }
  }
}
```

| Field | Default | Meaning |
| --- | --- | --- |
| `idle` | `600` | Seconds without calls before the server is stopped. `0` keeps it running for the whole session |
| `preload` | `false` | Start it as soon as the daemon starts instead of on the first call |
| `perSession` | `false` | Give each session its own copy, started in that session's project folder. For servers that keep state between calls, such as a browser |
| `disabled` | `false` | Keep the entry but do not offer its tools |

**Secrets out of the file:** `${NAME}` and `${NAME:-fallback}` in `command`, `args`, `env` and `cwd` are read from
the environment when the server starts. An unset variable without a fallback fails that server with a message
naming the variable.

```json
"env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_TOKEN}" }
```

After adding or changing a server, run `mcp-ondemand refresh <name>`. A server without a cache is also started
once in the background the next time a session opens.

## How it works

- **Shared daemon:** the first session starts a small background daemon, and every session's `mcp-ondemand` becomes
  a pipe to it (a named pipe on Windows, a unix socket elsewhere). The daemon runs the servers, so sessions share
  them. It exits a minute after the last session has gone and the last server has stopped. It is started through
  a short-lived launcher, so it is not part of any one session's process tree. Set `MCP_ONDEMAND_SHARED=0` to run
  each session on its own instead, as in 1.1; if the daemon cannot start, a session falls back to that by itself.
- **Updates:** a session of a newer version asks an older daemon to step aside; it finishes its current sessions
  and exits while the new one takes over. A changed `servers.json` is picked up by the next session that starts:
  changed servers are restarted, the rest keep running.

- **Cache:** each server's tools, prompts, resources, resource templates and instructions are stored per server, tied to its command, args,
  env and cwd. Change any of those and the cache is rebuilt. Env values are hashed, never written to the cache.
- **Staying current:** whenever a server runs, its live tool list is compared with the cache. If they differ, the
  cache is updated and Claude is sent `notifications/tools/list_changed`. A server's own `list_changed` does the same.
- **Calls:** progress notifications from the real server are passed to the client, and a cancelled call is
  cancelled on the real server. Calls that arrive while a server is starting wait for the same start. A server that crashes is
  started fresh on the next call.
- **Stopping:** the whole process tree is killed (`taskkill /T` on Windows, the process and its descendants
  elsewhere), so launchers do not leave the real server behind.

## Limits

- **The first call to a stopped server is slower**, by however long that server takes to start (usually 1 to 5 seconds).
- **Stopping a server loses its state.** A browser automation server forgets its open page. Give such servers a
  longer `idle`, or `0`, and `perSession` so sessions do not share one browser.
- **Shared servers run in the daemon's environment**: the environment of the session that started it, with the
  mcp-ondemand folder as working folder. A server that depends on the session's project folder should be
  `perSession`, which starts it in that folder.
- **Only local (stdio) servers.** Remote servers have no process to save.
- **Plugins:** a plugin whose servers include a remote one is left alone by `import --plugins`, because switching
  the plugin off would lose that server too.
- **Resource subscriptions** (`resources/subscribe`) are not passed through.
- mcp-ondemand sees everything that passes between Claude and your servers, including the env you configure for
  them. It runs locally and makes no network requests of its own. Read the code: it is about 1,150 lines.

## Compared with others

| | Tools Claude sees | On demand | Idle stop | Process trees | Shared across sessions | Prompts, resources | Progress, cancel | Plugins |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **mcp-ondemand** | real tools | yes | yes | yes | yes, or per session | yes | yes | yes |
| [mcp-snooze](https://github.com/askmegit/mcp-snooze) | real tools | yes | yes | yes (Windows untested) | no | yes | passes through | no |
| [voicetreelab/lazy-mcp](https://github.com/voicetreelab/lazy-mcp) | 2 meta-tools | yes | no | no | no | no | no | no |
| [mcp-lazy-load](https://github.com/petercha90/mcp-lazy-load), [mcp-lazy-proxy](https://github.com/sarthakpranesh/mcp-lazy-proxy) | meta-tools | yes | varies | no | no | no | no | no |

Meta-tool proxies were built to save context. Claude Code already loads tool schemas on demand, so here the cost
that is left is processes and memory, which is what mcp-ondemand removes.

## Undo

```bash
mcp-ondemand restore
```

puts every server back where `import` found it. Every change to `~/.claude.json` is backed up in
`~/.mcp-ondemand/backups/` first.

## Develop

```bash
npm install
npm test
```

The tests run the real proxy against a fake MCP server: lazy start, shared starts, idle stop, long calls,
crashes, restart, cleanup when the session ends, prompts, resources, progress, cancellation, `${VAR}`, two
sessions sharing one daemon, perSession servers, a daemon stepping aside for another version and exiting when
idle, and import and restore of servers and plugins. CI runs them on Linux, macOS and Windows.

## License

MIT
