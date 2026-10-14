# Setup prompt

Paste this into Claude Code (or Codex, or any coding agent with a shell) to have it install mcp-ondemand for you.

---

```text
Install mcp-ondemand (https://github.com/elis132/mcp-ondemand) so my local MCP servers only run while they are used.

1. Check that Node.js 20 or newer is installed (`node --version`). If not, stop and tell me.
2. Clone it to ~/mcp-ondemand (on Windows: %USERPROFILE%\mcp-ondemand) and run `npm install` there.
   If the folder already exists, run `git pull` and `npm install` instead.
3. Show me what would move, without changing anything:
   node ~/mcp-ondemand/bin/mcp-ondemand.mjs import --dry-run
   List the servers it would move and the ones it would leave, and ask me before going on.
4. After I say yes, run the import for real:
   node ~/mcp-ondemand/bin/mcp-ondemand.mjs import
   It backs up ~/.claude.json first and prints where. Tell me the backup path.
5. If any server failed to start while building its cache, show me its error. Common causes: a broken npm cache
   (try `npm cache verify`), a missing command on PATH, or a server that needs credentials. If a secret sits in
   servers.json in plain text, offer to move it to an environment variable and use "${NAME}" there instead. Fix what you can,
   then run: node ~/mcp-ondemand/bin/mcp-ondemand.mjs refresh <name>
6. Check the result with `claude mcp list` (it should show `ondemand` as connected) and
   `node ~/mcp-ondemand/bin/mcp-ondemand.mjs status`.
7. Show me which Claude Code plugins run their own MCP servers:
   node ~/mcp-ondemand/bin/mcp-ondemand.mjs import --plugins --dry-run
   Ask me which to move. Then run it with --only <the ones I picked> (without --dry-run). It switches those
   plugins off, backs up the settings, and builds their caches. Servers that keep state between calls (a browser,
   for example) should get "idle": 1800 or more and "perSession": true in ~/.mcp-ondemand/servers.json, so each
   session has its own copy instead of sharing one.
   Finally run: node ~/mcp-ondemand/bin/mcp-ondemand.mjs doctor, and fix what it reports.
8. Tell me: tools are now named mcp__ondemand__<server>__<tool>, the first call to a stopped server takes a few
   seconds, I need to restart Claude Code, and `node ~/mcp-ondemand/bin/mcp-ondemand.mjs restore` undoes everything.

Do not add new MCP servers to ~/.claude.json with `claude mcp add` afterwards: put them in
~/.mcp-ondemand/servers.json and run `refresh <name>`, or they will be always-on again.
```
