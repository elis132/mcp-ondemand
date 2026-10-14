// A small MCP server for the tests. Records each start in FAKE_LOG so the tests can count starts.
import { appendFileSync } from "node:fs";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

appendFileSync(process.env.FAKE_LOG, `start ${process.pid}\n`);
const s = new McpServer({ name: "fake", version: "1" }, { instructions: "Fake server instructions." });
const done = (text) => ({ content: [{ type: "text", text }] });

s.registerTool("echo", { description: "Echo text back", inputSchema: { text: z.string() } }, async ({ text }) => done(`echo:${text}`));
s.registerTool("env", { description: "Return an environment variable", inputSchema: { name: z.string() } }, async ({ name }) => done(String(process.env[name])));
s.registerTool("slow", { description: "Wait, then answer", inputSchema: { ms: z.number() } }, async ({ ms }, extra) => {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    extra.signal.addEventListener("abort", () => {
      clearTimeout(timer);
      appendFileSync(process.env.FAKE_LOG, `cancelled ${process.pid}\n`);
      reject(new Error("cancelled"));
    });
  });
  return done("done");
});
s.registerTool("progress", { description: "Report progress three times" }, async (extra) => {
  const token = extra._meta?.progressToken;
  for (let i = 1; i <= 3; i++) {
    if (token !== undefined) await extra.sendNotification({ method: "notifications/progress", params: { progressToken: token, progress: i, total: 3 } });
    // Spread out like real work. Sent back to back with the answer, the SDK client can handle the answer first
    // and drop the late progress, with or without a proxy in between.
    await new Promise((r) => setTimeout(r, 50));
  }
  return done("progressed");
});
s.registerTool("cwd", { description: "Return the working folder" }, async () => done(process.cwd()));
s.registerTool("crash", { description: "Exit the process" }, async () => process.exit(1));

s.registerPrompt("greet", { description: "A greeting", argsSchema: { who: z.string() } }, ({ who }) => ({
  messages: [{ role: "user", content: { type: "text", text: `Hello ${who}` } }],
}));
s.registerResource("readme", "fake://readme", { description: "A fixed resource" }, async (uri) => ({ contents: [{ uri: uri.href, text: "fake readme" }] }));
s.registerResource("note", new ResourceTemplate("note://{id}", { list: undefined }), { description: "Notes by id" }, async (uri, { id }) => ({
  contents: [{ uri: uri.href, text: `note ${id}` }],
}));

await s.connect(new StdioServerTransport());
