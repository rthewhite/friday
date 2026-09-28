// Minimal stdio MCP server for mcp.test.ts: serves one tool named after $FIXTURE_TOOL.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server({ name: "stdio-fixture", version: "0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{ name: process.env.FIXTURE_TOOL ?? "unset", description: process.argv[2] ?? "", inputSchema: { type: "object" } }],
}));
await server.connect(new StdioServerTransport());
