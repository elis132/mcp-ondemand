# Setup prompt

Paste this into Claude Code (or Codex, or any coding agent with a shell) to have it install mcp-ondemand for you.

---

```text
Install mcp-ondemand (https://github.com/elis132/mcp-ondemand) so my local MCP servers only run while they are used.

1. Check that Node.js 20 or newer is installed (`node --version`). If not, stop and tell me.
2. Install it: npm install -g @elis132/mcp-ondemand
   (Already installed? npm update -g @elis132/mcp-ondemand.) Check with: mcp-ondemand --version
3. Detect whether this session is Claude Code or Codex. Use --client claude or --client codex explicitly on
   every management command below. If both are installed and session detection is ambiguous, ask which client.
   Show me what would move, without changing anything:
   mcp-ondemand import --client <client> --dry-run
   List the servers it would move and the ones it would leave, and ask me before going on.
4. After I say yes, run the import for real:
   mcp-ondemand import --client <client>
   It backs up that client's config first and prints where. Tell me the backup path.
5. If any server failed to start while building its cache, show me its error. Common causes: a broken npm cache
   (try `npm cache verify`), a missing command on PATH, or a server that needs credentials. If a secret sits in
   servers.json in plain text, offer to move it to an environment variable and use "${NAME}" there instead. Fix what you can,
   then run: mcp-ondemand refresh <name>
6. Check the result with `claude mcp list` or `codex mcp list` (it should show `ondemand`) and
   `mcp-ondemand status --client <client>`. Claude and Codex have separate data folders by default:
   ~/.mcp-ondemand and ~/.mcp-ondemand-codex. Codex-native runtimes, remote and disabled servers,
   and entries with unsupported permission or environment fields stay in place.
7. For Claude Code only, show me which plugins run their own MCP servers:
   mcp-ondemand import --plugins --dry-run
   Ask me which to move. Then run it with --only <the ones I picked> (without --dry-run). It switches those
   plugins off, backs up the settings, and builds their caches. Servers that keep state between calls (a browser,
   for example) should get "idle": 1800 or more and "perSession": true in ~/.mcp-ondemand/servers.json, so each
   session has its own copy instead of sharing one.
   Finally run: mcp-ondemand doctor --client <client>, and fix what it reports.
8. Tell me: tools are now named mcp__ondemand__<server>__<tool>, the first call to a stopped server takes a few
   seconds, I need to restart my client, and `mcp-ondemand restore --client <client>` undoes the import.

Do not add new MCP servers to ~/.claude.json with `claude mcp add` afterwards: put them in
~/.mcp-ondemand/servers.json and run `refresh <name>`, or they will be always-on again.
```
