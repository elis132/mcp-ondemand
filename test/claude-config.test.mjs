// import and restore against a throwaway ~/.claude.json.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const dir = mkdtempSync(join(tmpdir(), "mcp-ondemand-cfg-"));
process.env.MCP_ONDEMAND_HOME = join(dir, "home");
process.env.MCP_ONDEMAND_CLAUDE_JSON = join(dir, "claude.json");
process.env.MCP_ONDEMAND_CLAUDE_DIR = join(dir, "dot-claude");

// Two enabled plugins (one local server, one remote) and one disabled plugin.
const pluginRoot = join(dir, "plugins", "browser");
mkdirSync(join(dir, "dot-claude", "plugins"), { recursive: true });
mkdirSync(pluginRoot, { recursive: true });
writeFileSync(join(pluginRoot, ".mcp.json"), JSON.stringify({ browser: { command: "npx", args: ["-y", "browser-mcp", "--config", "${CLAUDE_PLUGIN_ROOT}/cfg.json"] } }));
mkdirSync(join(dir, "plugins", "cloud", ".claude-plugin"), { recursive: true });
writeFileSync(join(dir, "plugins", "cloud", ".claude-plugin", "plugin.json"), JSON.stringify({ name: "cloud", mcpServers: { cloud: { type: "http", url: "https://example.com/mcp" } } }));
writeFileSync(join(dir, "dot-claude", "plugins", "installed_plugins.json"), JSON.stringify({
  plugins: {
    "browser@market": [{ scope: "user", installPath: pluginRoot }],
    "cloud@market": [{ scope: "user", installPath: join(dir, "plugins", "cloud") }],
    "off@market": [{ scope: "user", installPath: pluginRoot }],
  },
}));
writeFileSync(join(dir, "dot-claude", "settings.json"), JSON.stringify({ model: "x", enabledPlugins: { "browser@market": true, "cloud@market": true, "off@market": false } }));
const settings = () => JSON.parse(readFileSync(join(dir, "dot-claude", "settings.json"), "utf8"));
const original = {
  numStartups: 7,
  mcpServers: {
    local: { type: "stdio", command: "node", args: ["server.js"], env: { TOKEN: "secret" } },
    remote: { type: "http", url: "https://example.com/mcp" },
  },
  projects: { "/work/app": { mcpServers: { db: { command: "uvx", args: ["db-mcp"] } } } },
};
writeFileSync(process.env.MCP_ONDEMAND_CLAUDE_JSON, JSON.stringify(original));
const { importPlugins, importServers, restoreServers } = await import("../src/claude-config.mjs");
const claude = () => JSON.parse(readFileSync(process.env.MCP_ONDEMAND_CLAUDE_JSON, "utf8"));
const servers = () => JSON.parse(readFileSync(join(dir, "home", "servers.json"), "utf8"));

test("import moves local servers behind the proxy and leaves remote ones and other settings alone", () => {
  assert.deepEqual(importServers({ dryRun: true }).moved, ["local"]);
  assert.deepEqual(claude(), original, "a dry run changes nothing");

  const r = importServers();
  assert.deepEqual(r.moved, ["local"]);
  assert.deepEqual(r.skipped, ["remote"]);
  const c = claude();
  assert.deepEqual(Object.keys(c.mcpServers).sort(), ["ondemand", "remote"]);
  assert.equal(c.mcpServers.ondemand.command, "node");
  assert.match(c.mcpServers.ondemand.args[0], /bin\/mcp-ondemand\.mjs$/);
  assert.equal(c.numStartups, 7);
  assert.deepEqual(servers().local, { command: "node", args: ["server.js"], env: { TOKEN: "secret" }, from: "user" });
  assert.equal(readdirSync(join(dir, "home", "backups")).length, 1);
});

test("a project's servers can be imported, and settings made in servers.json survive a re-import", () => {
  const s = servers();
  s.local.idle = 0;
  writeFileSync(join(dir, "home", "servers.json"), JSON.stringify(s));
  importServers({ project: "/work/app" });
  assert.equal(servers().db.command, "uvx");
  assert.equal(servers().local.idle, 0);
});

test("restore puts every server back where it came from and removes the proxy", () => {
  const r = restoreServers();
  assert.deepEqual(r.restored.sort(), ["db", "local"]);
  const c = claude();
  assert.deepEqual(c.mcpServers.local, { type: "stdio", env: { TOKEN: "secret" }, command: "node", args: ["server.js"] });
  assert.ok(!c.mcpServers.ondemand);
  assert.ok(c.mcpServers.remote);
  const project = Object.entries(c.projects).find(([k]) => k.endsWith("/work/app"))[1];
  assert.equal(project.mcpServers.db.command, "uvx");
  assert.ok(!project.mcpServers.ondemand);
  assert.deepEqual(servers(), {});
});

test("plugin servers move behind the proxy, their plugins are switched off, and restore switches them back on", () => {
  assert.deepEqual(importPlugins({ dryRun: true }).moved, ["browser"]);
  assert.equal(settings().enabledPlugins["browser@market"], true, "a dry run changes nothing");

  const r = importPlugins();
  assert.deepEqual(r.moved, ["browser"]);
  assert.deepEqual(r.plugins, ["browser@market"]);
  assert.deepEqual(r.skipped, ["cloud (cloud@market)"], "a plugin with a remote server is left alone");
  const browser = servers().browser;
  assert.equal(browser.command, "npx");
  assert.equal(browser.args[3], `${pluginRoot.replaceAll("\\", "/")}/cfg.json`, "${CLAUDE_PLUGIN_ROOT} filled in");
  assert.equal(browser.from, "plugin:browser@market");
  assert.deepEqual(settings().enabledPlugins, { "browser@market": false, "cloud@market": true, "off@market": false });
  assert.equal(settings().model, "x", "other settings untouched");
  assert.ok(claude().mcpServers.ondemand, "the proxy is registered");

  const back = restoreServers();
  assert.deepEqual(back.plugins, ["browser@market"]);
  assert.equal(settings().enabledPlugins["browser@market"], true);
  assert.ok(!claude().mcpServers.browser, "a plugin's server is not copied into ~/.claude.json");
  assert.ok(!claude().mcpServers.ondemand);
});
