# Changelog

## 1.2.0 (2026-10-14)

- Shared daemon: sessions share one copy of each server instead of starting their own. Started by the first
  session, outside any session's process tree, and gone a minute after the last session and server.
- `perSession: true` gives a server one copy per session, started in that session's project folder.
- A newer version takes over from an older daemon without cutting off its sessions.
- A changed `servers.json` is picked up by the next session; only changed servers restart.
- `stop` stops the daemon and its servers. `status` shows whether it runs.
- `MCP_ONDEMAND_SHARED=0` keeps every session on its own, and a session falls back to that if the daemon cannot start.

## 1.1.0 (2026-10-14)

- Prompts, resources and resource templates of the servers behind it are passed through, cached like tools.
- Progress notifications reach the client, and a cancelled call is cancelled on the real server.
- `${NAME}` and `${NAME:-fallback}` in servers.json are read from the environment, so secrets can stay out of the file.
- `import --plugins` moves the MCP servers of Claude Code plugins behind the proxy and switches the plugins off;
  `restore` switches them back on.
- `ondemand_status` shows each running server's memory, counted over its whole process tree.
- `doctor` checks the setup: Node version, registration, servers still always-on, plugins with their own
  servers, commands missing from PATH, unset variables, missing caches.
- `--version`.

## 1.0.0 (2026-10-14)

First release.

- One MCP proxy for all local servers: tools listed from a disk cache, servers started on their first call and stopped when idle.
- Whole process trees killed on stop and when the session ends (Windows, Linux, macOS).
- Cache kept current from the live server, with `notifications/tools/list_changed` sent to the client.
- Each server's instructions passed through.
- `ondemand_status` and `ondemand_restart` tools.
- `import`, `restore`, `refresh` and `status` commands for Claude Code's `~/.claude.json`, with backups.
