# mcp-ondemand

**Your MCP servers, running only while they are used.** For Claude Code and Codex. One small proxy shows your client every tool, starts a server
on its first call, shares it between all your open sessions, and stops it when it goes idle.

[![test](https://github.com/elis132/mcp-ondemand/actions/workflows/test.yml/badge.svg)](https://github.com/elis132/mcp-ondemand/actions/workflows/test.yml)

## Why

Claude Code starts **every** configured MCP server the moment a session opens, keeps all of them running until it
closes, and does it again for **every** session. Most of those servers are never called. Each one is a full
Node.js or Python process, usually behind a launcher like `npx` or `uvx` that is a process of its own.

Measured with six popular servers, started through `npx` as most setups do:

| Server | Memory while running | Start time |
| --- | ---: | ---: |
| playwright | 259 MB | 6.4 s |
| github | 208 MB | 3.9 s |
| filesystem | 217 MB | 5.3 s |
| memory | 213 MB | 5.4 s |
| sequential-thinking | 216 MB | 4.5 s |
| context7 | 237 MB | 5.6 s |
| **All six** | **1,350 MB** | |

mcp-ondemand itself costs 49 MB per open session plus 66 MB once for its shared daemon. With those six servers
configured:

| Open sessions | Without mcp-ondemand | With it, idle | With it, two servers in use |
| ---: | ---: | ---: | ---: |
| 1 | 1,350 MB, 6 servers | 115 MB | 611 MB |
| 3 | 4,050 MB, 18 servers | 213 MB | 709 MB |
| 5 | 6,750 MB, 30 servers | 311 MB | 807 MB |

Five open sessions go from **6.8 GB to under 0.9 GB**, even with two servers busy. Add servers and the gap grows:
without mcp-ondemand each one costs memory in every session whether you use it or not; with it, a server you
don't call costs nothing.

**What you give up:** the first call to a stopped server waits for it to start, a few seconds (the start times
above). After that it answers at full speed until it has been idle for 10 minutes.

Numbers from Windows 11 and Node 22; on Linux and macOS the launchers are lighter, the ratio stays. Measure your
own: `mcp-ondemand bench` for these six, `mcp-ondemand bench ~/.mcp-ondemand/servers.json` for your servers.

## What it does

- **Every tool, nothing running.** Claude sees all your tools with their real names and schemas, answered from a
  cache on disk. Claude Code's per-tool permissions keep working: no meta-tools, no extra round trips.
- **Starts on first use, stops when idle.** 10 minutes by default, never while a call is running.
- **Shared between sessions.** Five open sessions using the same server run one copy of it. Servers that hold state,
  like a browser, can be kept per session instead.
- **Nothing left behind.** Stopping kills the whole process tree, launchers included, and a session's own servers
  end with it. No more stray servers from sessions closed hours ago.
- **Complete pass-through.** Prompts, resources, progress reports and cancellation reach the real server: press Esc
  and the call stops there, not just in Claude.
- **Optional memory limits.** Restart a server that grows past its own limit, or keep all of them under one budget.
- **Easy to adopt, easy to leave.** `import` moves your existing servers (and plugin servers) over with a backup,
  `restore` puts them back. Changes to the config reach open sessions at once.

```
Claude session 1 ─┐                      ┌── github       (running, shared)
Claude session 2 ─┼── mcp-ondemand ──────┼── playwright   (one per session)
Claude session 3 ─┘     daemon           └── ...          (stopped)
```

## Install

Needs Node.js 20 or newer.

```bash
npm install -g @elis132/mcp-ondemand
mcp-ondemand import
```

`import` detects Claude Code or Codex from the active session. From a plain terminal with both installed, choose
explicitly:

```bash
mcp-ondemand import --client claude
mcp-ondemand import --client codex
```

Claude Code uses `~/.claude.json`. Codex uses `$CODEX_HOME/config.toml` (normally `~/.codex/config.toml`), or
`<project>/.codex/config.toml` with `--project`. Codex import preserves the TOML text and original server
settings, disables the imported entries, and registers the proxy; `restore --client codex` re-enables them
without overwriting unrelated settings changed since import. Native `node_repl`/`cua_repl`, disabled entries,
remote servers, and entries with unsupported fields (including tool allowlists and `env_vars`) stay in place.
Codex servers default to `perSession: true` and `idle: 1800` to preserve project folders and isolate state;
set `perSession: false` for servers you want to share across Codex sessions. Startup and tool timeouts are retained.

The two clients have separate server lists and daemons by default: `~/.mcp-ondemand/` for Claude Code and
`~/.mcp-ondemand-codex/` for Codex. `--client claude|codex` works with `import`, `restore`, `doctor`, `status`,
`refresh` and `stop`; `MCP_ONDEMAND_CLIENT` overrides detection, and `MCP_ONDEMAND_HOME` overrides the data folder.
Both client configs are never automatically merged. Codex plugin-managed servers are left alone;
`--plugins` is currently Claude Code only.

For Claude Code, `import` moves the local (stdio) MCP servers from your user-level config behind
mcp-ondemand, puts one `ondemand` server in their place, backs up the old config, and starts each server once to
build its tool cache. Remote (HTTP/SSE) servers have no local process and are left where they are.

Servers that come from Claude Code plugins (Playwright, for example) are moved separately:

```bash
mcp-ondemand import --plugins
```

That switches those plugins off, so they stop starting their own copy. Restart your client. `claude mcp list`
or `codex mcp list` should show `ondemand`, and `mcp-ondemand doctor --client claude` (or `codex`) checks the setup.

Update with `npm update -g @elis132/mcp-ondemand`: the running daemon notices the new code and hands over by itself.

**Or let your agent do it:** paste [SETUP_PROMPT.md](SETUP_PROMPT.md) into Claude Code, Codex or similar.

<details>
<summary>From source instead</summary>

```bash
git clone https://github.com/elis132/mcp-ondemand.git ~/mcp-ondemand
cd ~/mcp-ondemand && npm install
node bin/mcp-ondemand.mjs import
```

Use `node ~/mcp-ondemand/bin/mcp-ondemand.mjs` wherever this README says `mcp-ondemand`, or run `npm link` once in
the folder.
</details>

## Use

Tools are named `<server>__<tool>`, so they appear as `mcp__ondemand__github__create_issue` in clients using MCP prefixes.
Two tools of its own:

| Tool | Does |
| --- | --- |
| `ondemand_status` | Which servers are running, their process ids and memory (whole process tree), calls made, the last start error |
| `ondemand_restart` | Stop a server that hangs. It starts again on its next call |

Each server's own instructions are passed on to Claude. Prompts are named `<server>__<prompt>` like tools;
resources keep their own URIs.

## Commands

```bash
mcp-ondemand import [--client claude|codex] [--project <dir>] [--only a,b] [--except a,b] [--dry-run]
mcp-ondemand import --plugins [--only a,b] [--dry-run]   # servers from Claude Code plugins
mcp-ondemand refresh [name]        # start servers once to rebuild their cache
mcp-ondemand status                # what runs now, with memory (asks the daemon), or the configured servers
mcp-ondemand doctor                # check the setup and say what to fix
mcp-ondemand stop                  # stop the shared daemon and every server it runs
mcp-ondemand bench [servers.json]  # measure what your servers cost, with and without mcp-ondemand
mcp-ondemand restore [--only a,b]  # put servers back where they came from
```


## Configure

Everything lives in the selected client's data folder (`~/.mcp-ondemand/` or `~/.mcp-ondemand-codex/`; set
`MCP_ONDEMAND_HOME` to move it): `servers.json`, the tool `cache/`, config `backups/`, and `ondemand.log`.

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
| `maxMemory` | none | MB. A server whose process tree uses more is stopped, never during a call, and starts fresh on its next call |

**For all servers together**, `~/.mcp-ondemand/settings.json`:

```json
{ "memoryBudget": 2000, "idle": 600 }
```

| Field | Meaning |
| --- | --- |
| `memoryBudget` | MB for all running servers together. Over it, the least recently used idle servers are stopped until it fits |
| `idle` | The default idle time for servers that do not set their own |

Memory is checked every minute, and only when `maxMemory` or `memoryBudget` is set.

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
- **Updates:** a session running different code (a new version, a `git pull`, a local edit: sessions and daemon
  compare a fingerprint of the code) asks the running daemon to step aside. It finishes its current sessions and
  exits while the new one takes over. A changed `servers.json` or a rebuilt cache is picked up at once by open
  sessions, which are told only when what they see actually changed. Changed servers restart, the rest keep running.
- **Failing servers:** a server that will not start is not retried on every call. It waits 5 s, then 10 s, 20 s and
  so on up to 5 minutes, and calls meanwhile get its last error at once. `ondemand_restart` retries straight away.
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

- **The first call to a stopped server is slower**, by however long that server takes to start (4 to 6 seconds for
  the servers measured above).
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
  them. It runs locally and makes no network requests of its own. Read the code: it is about 1,350 lines.

## Compared with others

| | Tools Claude sees | On demand | Idle stop | Process trees | Shared across sessions | Prompts, resources | Progress, cancel | Plugins |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **mcp-ondemand** | real tools | yes | yes | yes | yes, or per session | yes | yes | yes |
| [mcp-snooze](https://github.com/askmegit/mcp-snooze) | real tools | yes | yes | yes (Windows untested) | no | yes | passes through | no |
| [mcp-on-demand](https://github.com/mfagerlund/mcp-on-demand) | none: a CLI/HTTP API Claude calls | yes, started by hand | no, stopped by hand | not documented | not documented | no | no | no |
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
node bench/measure.mjs      # the measurements at the top of this README (same as mcp-ondemand bench)
```

The tests run the real proxy against a fake MCP server: lazy start, shared starts, idle stop, long calls,
crashes, restart, cleanup when the session ends, prompts, resources, progress, cancellation, `${VAR}`, two
sessions sharing one daemon, perSession servers, a daemon stepping aside for another version, surviving hard
disconnects and exiting when idle, backoff for failing servers, memory limits, live config changes, and import
and restore of servers and plugins. CI runs them on Linux, macOS and Windows.

## License

MIT
