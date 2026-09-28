/** A real MCP server over streamable HTTP on an ephemeral port, for testing the MCP source end to end. */
import { createServer, type IncomingHttpHeaders } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

export interface McpFixture {
  url: string;
  /** Headers of every HTTP request received, in order. */
  requests: IncomingHttpHeaders[];
  /** Tool names served by tools/list; mutable. */
  tools: string[];
  /** Answer every request with this HTTP status instead of MCP (e.g. 401); undefined serves normally. */
  rejectWith?: number;
  /** Never answer tools/list. */
  hangListTools: boolean;
  close(): Promise<void>;
}

export async function startMcpFixture(tools: string[] = ["turn_on", "turn_off"]): Promise<McpFixture> {
  const f: McpFixture = { url: "", requests: [], tools, hangListTools: false, close: async () => {} };
  const http = createServer(async (req, res) => {
    f.requests.push(req.headers);
    if (f.rejectWith) {
      res.statusCode = f.rejectWith;
      return res.end(`rejected: ${req.headers.authorization ?? ""}`); // echoes the credential, like a careless server
    }
    // Stateless: a fresh server and transport per request.
    const server = new Server({ name: "fixture", version: "0" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      if (f.hangListTools) await new Promise(() => {});
      return { tools: f.tools.map((name) => ({ name, description: `${name} tool`, inputSchema: { type: "object" as const } })) };
    });
    server.setRequestHandler(CallToolRequestSchema, async ({ params }) => ({ content: [{ type: "text", text: JSON.stringify({ called: params.name }) }] }));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => void transport.close().then(() => server.close()));
    await server.connect(transport);
    await transport.handleRequest(req, res);
  });
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  f.url = `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`;
  f.close = async () => {
    http.closeAllConnections();
    http.close();
    await once(http, "close");
  };
  return f;
}
