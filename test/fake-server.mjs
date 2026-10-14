// A tiny MCP server for the tests. Records its start in a file so the test can count starts.
import { appendFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
appendFileSync(process.env.FAKE_LOG, `start ${process.pid}\n`);
const s = new McpServer({ name: "fake", version: "1" }, { instructions: "Fake server instructions." });
s.registerTool("echo", { description: "Echo text back", inputSchema: { text: z.string() } }, async ({ text }) => ({ content: [{ type: "text", text: `echo:${text}` }] }));
s.registerTool("slow", { description: "Wait, then answer", inputSchema: { ms: z.number() } }, async ({ ms }) => { await new Promise((r) => setTimeout(r, ms)); return { content: [{ type: "text", text: "done" }] }; });
s.registerTool("crash", { description: "Exit the process" }, async () => process.exit(1));
await s.connect(new StdioServerTransport());
