# Changelog

## 1.0.0 (2026-10-14)

First release.

- One MCP proxy for all local servers: tools listed from a disk cache, servers started on their first call and stopped when idle.
- Whole process trees killed on stop and when the session ends (Windows, Linux, macOS).
- Cache kept current from the live server, with `notifications/tools/list_changed` sent to the client.
- Each server's instructions passed through.
- `ondemand_status` and `ondemand_restart` tools.
- `import`, `restore`, `refresh` and `status` commands for Claude Code's `~/.claude.json`, with backups.
