# mcp-ondemand

**MCP servers that only run while they are used.**

Claude Code starts every configured MCP server when a session opens, keeps all of them running for the whole
session, and with several sessions open you get several copies of each. Ten servers and four sessions is forty
processes, most of them never called. Some are left behind after their session ends.

mcp-ondemand is one small MCP server that sits in front of all the others:

- **Claude sees every real tool at once**, answered from a cache on disk. Nothing else is started.
- **A server starts on its first tool call**, and stops after it has been idle for a while (10 minutes by default).
  A call that is still running is never cut off.
- **Nothing outlives the session.** When Claude closes, every server it started is killed, including the children
  that launchers like `npx`, `uvx`, `cmd` and `wsl` start.
- **Your tools keep their real names and schemas**, so Claude Code's per-tool permissions keep working. No
  meta-tools, no extra round trips to find a tool.

```
Claude Code ── mcp-ondemand ──┬── playwright     (running, 1 call in flight)
                              ├── github         (stopped)
                              └── ...            (stopped)
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

Restart Claude Code. `claude mcp list` should show `ondemand` as connected.

**Or let your agent do it:** paste [SETUP_PROMPT.md](SETUP_PROMPT.md) into Claude Code, Codex or similar.

## Use

Tools are named `<server>__<tool>`, so in Claude Code they appear as `mcp__ondemand__github__create_issue`.
Two tools of its own:

| Tool | Does |
| --- | --- |
| `ondemand_status` | Which servers are running, their process ids, calls made, the last start error |
| `ondemand_restart` | Stop a server that hangs. It starts again on its next call |

Each server's own instructions are passed on to Claude.

## Commands

```bash
mcp-ondemand import [--project <dir>] [--only a,b] [--except a,b] [--dry-run]
mcp-ondemand refresh [name]     # start servers once to rebuild their tool cache
mcp-ondemand status             # configured servers and their cache
mcp-ondemand restore [--only a,b]  # put servers back into ~/.claude.json
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
| `preload` | `false` | Start it with the session instead of on the first call |
| `disabled` | `false` | Keep the entry but do not offer its tools |

After adding or changing a server, run `mcp-ondemand refresh <name>`. A server without a cache is also started
once in the background the next time a session opens.

## How it works

- **Cache:** each server's `tools/list` (and its instructions) is stored per server, tied to its command, args,
  env and cwd. Change any of those and the cache is rebuilt. Env values are hashed, never written to the cache.
- **Staying current:** whenever a server runs, its live tool list is compared with the cache. If they differ, the
  cache is updated and Claude is sent `notifications/tools/list_changed`. A server's own `list_changed` does the same.
- **Starting:** calls that arrive while a server is starting wait for the same start. A server that crashes is
  started fresh on the next call.
- **Stopping:** the whole process tree is killed (`taskkill /T` on Windows, the process and its descendants
  elsewhere), so launchers do not leave the real server behind.

## Limits

- **The first call to a stopped server is slower**, by however long that server takes to start (usually 1 to 5 seconds).
- **Stopping a server loses its state.** A browser automation server forgets its open page. Give such servers a
  longer `idle`, or `0`.
- **Tools only.** MCP prompts and resources of the servers behind it are not passed through.
- **Only local (stdio) servers.** Remote servers have no process to save.
- **Plugin MCP servers** (from Claude Code plugins) are not imported automatically. Copy the plugin's `.mcp.json`
  entry into `servers.json` and disable the plugin, or leave it.
- mcp-ondemand sees everything that passes between Claude and your servers, including the env you configure for
  them. It runs locally and makes no network requests of its own. Read the code: it is about 500 lines.

## Compared with others

| | Tools Claude sees | Starts on demand | Stops when idle | Kills process trees | One process for all |
| --- | --- | --- | --- | --- | --- |
| **mcp-ondemand** | real tools, from cache | yes | yes | yes | yes |
| [mcp-snooze](https://github.com/askmegit/mcp-snooze) | real tools, from cache | yes | yes | yes (Windows untested) | no, one per server |
| [voicetreelab/lazy-mcp](https://github.com/voicetreelab/lazy-mcp) | 2 meta-tools, a category tree | yes | no | no | yes |
| [mcp-lazy-load](https://github.com/petercha90/mcp-lazy-load), [mcp-lazy-proxy](https://github.com/sarthakpranesh/mcp-lazy-proxy) | meta-tools | yes | varies | no | yes |

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
crashes, restart, and cleanup when the session ends. CI runs them on Linux, macOS and Windows.

## License

MIT
