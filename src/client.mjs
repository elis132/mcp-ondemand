import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const codexConfigPath = (env = process.env) => env.MCP_ONDEMAND_CODEX_CONFIG ?? join(env.CODEX_HOME ?? join(homedir(), ".codex"), "config.toml");
export const claudeConfigPath = (env = process.env) => env.MCP_ONDEMAND_CLAUDE_JSON ?? join(homedir(), ".claude.json");
export const clientHome = (client) => join(homedir(), client === "codex" ? ".mcp-ondemand-codex" : ".mcp-ondemand");

export function detectClient({ client, env = process.env, exists = existsSync } = {}) {
  client ??= env.MCP_ONDEMAND_CLIENT;
  if (client) {
    if (!["claude", "codex"].includes(client)) throw new Error("--client must be claude or codex");
    return client;
  }
  const codex = Boolean(env.CODEX_THREAD_ID || env.CODEX_SESSION_ID);
  const claude = env.CLAUDECODE === "1" || Boolean(env.CLAUDE_CODE_ENTRYPOINT);
  if (codex !== claude) return codex ? "codex" : "claude";
  if (!codex && !claude) {
    const installed = ["claude", "codex"].filter((c) => exists(c === "codex" ? codexConfigPath(env) : claudeConfigPath(env)));
    if (installed.length === 1) return installed[0];
  }
  throw new Error("Cannot unambiguously detect the client. Use --client claude or --client codex.");
}
