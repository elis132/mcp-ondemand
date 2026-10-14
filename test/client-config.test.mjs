import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const dir = mkdtempSync(join(tmpdir(), "ondemand-clients-"));
process.env.MCP_ONDEMAND_HOME = join(dir, "proxy");
process.env.MCP_ONDEMAND_CODEX_CONFIG = join(dir, "codex", "config.toml");
mkdirSync(join(dir, "codex"));
const { detectClient } = await import("../src/client.mjs");
const { importServers, restoreServers, readConfig } = await import("../src/codex-config.mjs");
const file = process.env.MCP_ONDEMAND_CODEX_CONFIG;
const original = `# keep my settings and comments\nmodel = "example"\n[mcp_servers.browser]\ncommand = "node"\nargs = ["browser.mjs"]\nstartup_timeout_sec = 90\ntool_timeout_sec = 300\n[mcp_servers.browser.env]\nTOKEN = "test-secret"\n[mcp_servers.remote]\nurl = "https://example.com/mcp"\n[mcp_servers.off]\ncommand = "node"\nenabled = false\n[mcp_servers.node_repl]\ncommand = "native-repl"\n`;
writeFileSync(file, original);
const servers = () => JSON.parse(readFileSync(join(dir, "proxy", "servers.json"), "utf8"));

test("client detection uses session markers and explicit selection, rejects ambiguity", () => {
  const both = () => true;
  assert.equal(detectClient({ env: { CODEX_THREAD_ID: "x", CLAUDE_CODE_USE_POWERSHELL_TOOL: "1" }, exists: both }), "codex");
  assert.equal(detectClient({ env: { CLAUDECODE: "1" }, exists: both }), "claude");
  assert.equal(detectClient({ client: "claude", env: { CODEX_THREAD_ID: "x" }, exists: both }), "claude");
  assert.throws(() => detectClient({ env: {}, exists: both }), /--client/);
  assert.throws(() => detectClient({ client: "typo" }), /client/);
});

test("Codex dry-run is read-only and skips native, remote and disabled servers", () => {
  const r = importServers({ dryRun: true });
  assert.deepEqual(r.moved, ["browser"]);
  assert.deepEqual(r.skipped.sort(), ["node_repl", "off", "remote"]);
  assert.equal(readFileSync(file, "utf8"), original);
  assert.equal(existsSync(join(dir, "proxy")), false);
});

test("Codex import preserves source text, launch settings and a restorable original", () => {
  const r = importServers();
  assert.equal(readFileSync(r.backup, "utf8"), original);
  const c = readConfig();
  assert.equal(c.mcp_servers.browser.enabled, false);
  assert.equal(c.mcp_servers.remote.url, "https://example.com/mcp");
  assert.equal(c.mcp_servers.node_repl.command, "native-repl");
  assert.match(readFileSync(file, "utf8"), /^# keep my settings and comments/);
  assert.equal(servers().browser.env.TOKEN, "test-secret");
  assert.equal(servers().browser.perSession, true);
  assert.equal(c.mcp_servers.ondemand.env.MCP_ONDEMAND_HOME, process.env.MCP_ONDEMAND_HOME);
  assert.deepEqual(importServers().moved, [], "re-import is idempotent");
  writeFileSync(file, readFileSync(file, "utf8") + '\n[projects."/work"]\ntrust_level = "trusted"\n');
  assert.deepEqual(restoreServers().restored, ["browser"]);
  const restored = readConfig();
  assert.equal(restored.mcp_servers.browser.enabled, undefined);
  assert.equal(restored.mcp_servers.browser.tool_timeout_sec, 300);
  assert.equal(restored.projects["/work"].trust_level, "trusted");
  assert.equal(restored.mcp_servers.ondemand, undefined);
  assert.deepEqual(servers(), {});
});

test("quoted Codex names and partial restore preserve disabled entries and comments", () => {
  writeFileSync(file, original + '\n[mcp_servers."my.db"] # quoted name\ncommand = "node"\nenabled = true # previously enabled\n');
  importServers();
  assert.deepEqual(restoreServers({ only: ["browser"] }).restored, ["browser"]);
  assert.ok(readConfig().mcp_servers.ondemand);
  assert.equal(readConfig().mcp_servers["my.db"].enabled, false);
  restoreServers();
  assert.equal(readConfig().mcp_servers["my.db"].enabled, true);
  assert.match(readFileSync(file, "utf8"), /enabled = true # previously enabled/);
  assert.equal(readConfig().mcp_servers.off.enabled, false);
});

test("unsupported permission filters and env forwarding stay native", () => {
  const text = original + '\n[mcp_servers.filtered]\ncommand = "node"\nenabled_tools = ["read"]\n[mcp_servers.forward]\ncommand = "node"\nenv_vars = ["TOKEN"]\n';
  writeFileSync(file, text);
  const r = importServers({ dryRun: true });
  assert.ok(r.skipped.includes("filtered"));
  assert.ok(r.skipped.includes("forward"));
  assert.equal(readFileSync(file, "utf8"), text);
});

test("adding another server and importing again keeps the existing proxy", () => {
  writeFileSync(file, original);
  importServers();
  writeFileSync(file, readFileSync(file, "utf8") + '\n[mcp_servers.extra]\ncommand = "node"\n');
  assert.deepEqual(importServers().moved, ["extra"]);
  assert.deepEqual(Object.keys(servers()).sort(), ["browser", "extra"]);
  restoreServers();
});

test("CLI detects Codex from its session and --client overrides it", () => {
  writeFileSync(file, original);
  const cli = new URL("../bin/mcp-ondemand.mjs", import.meta.url);
  const run = (...args) => spawnSync(process.execPath, [fileURLToPath(cli), ...args], { encoding: "utf8", env: { ...process.env, CLAUDECODE: "", CLAUDE_CODE_ENTRYPOINT: "", CODEX_THREAD_ID: "test" } });
  const r = run("import", "--dry-run");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /browser/);
  const invalid = run("import", "--client", "typo", "--dry-run");
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /client must be/);
  const plugins = run("import", "--client", "codex", "--plugins", "--dry-run");
  assert.notEqual(plugins.status, 0);
  assert.match(plugins.stderr, /Claude Code only/);
  assert.equal(readFileSync(file, "utf8"), original);
});

test("project config uses its own path and leaves the user config alone", () => {
  const project = join(dir, "project");
  mkdirSync(join(project, ".codex"), { recursive: true });
  const projectFile = join(project, ".codex", "config.toml");
  writeFileSync(projectFile, original);
  writeFileSync(file, original);
  importServers({ project });
  assert.equal(readFileSync(file, "utf8"), original);
  assert.equal(readConfig({ project }).mcp_servers.browser.enabled, false);
  restoreServers({ project });
  assert.equal(readConfig({ project }).mcp_servers.browser.enabled, undefined);
});

test("an unsafe TOML edit is rejected without changing either config", () => {
  const text = 'note = """\n[mcp_servers.browser]\nenabled = true\n"""\n' + original;
  writeFileSync(file, text);
  const before = readFileSync(join(dir, "proxy", "servers.json"), "utf8");
  assert.throws(() => importServers(), /unrelated settings/);
  assert.equal(readFileSync(file, "utf8"), text);
  assert.equal(readFileSync(join(dir, "proxy", "servers.json"), "utf8"), before);
});
