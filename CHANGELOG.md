# Changelog

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
