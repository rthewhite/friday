import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import WebSocket, { WebSocketServer } from "ws";
import { WsTransport, toJsonSchema } from "../src/remote/index.js";
import { Type } from "../src/index.js";

test("tools/list round-trips between an MCP server and client over WsTransport", async () => {
  const wss = new WebSocketServer({ port: 0 });
  await once(wss, "listening");
  wss.on("connection", async (sock) => {
    const server = new Server({ name: "t", version: "0" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: "hi", description: "d", inputSchema: { type: "object" } }] }));
    await server.connect(new WsTransport(sock));
  });
  const port = (wss.address() as { port: number }).port;
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await once(ws, "open");
  const client = new Client({ name: "c", version: "0" });
  await client.connect(new WsTransport(ws));
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name), ["hi"]);
  await client.close();
  wss.close();
});

test("send on a closed socket rejects", async () => {
  const wss = new WebSocketServer({ port: 0 });
  await once(wss, "listening");
  const ws = new WebSocket(`ws://127.0.0.1:${(wss.address() as { port: number }).port}`);
  await once(ws, "open");
  ws.close();
  await once(ws, "close");
  await assert.rejects(new WsTransport(ws).send({ jsonrpc: "2.0", id: 1, method: "x" }), /not open/);
  wss.close();
});

test("toJsonSchema converts Gemini schemas", () => {
  assert.deepEqual(toJsonSchema(undefined), { type: "object", properties: {} });
  assert.deepEqual(toJsonSchema({ type: Type.OBJECT }), { type: "object", properties: {} });
  assert.deepEqual(
    toJsonSchema({
      type: Type.OBJECT,
      properties: {
        q: { type: Type.STRING, description: "query", enum: ["a", "b"] },
        n: { type: Type.INTEGER, nullable: true },
        list: { type: Type.ARRAY, items: { type: Type.NUMBER } },
      },
      required: ["q"],
    }),
    {
      type: "object",
      properties: {
        q: { type: "string", description: "query", enum: ["a", "b"] },
        n: { type: ["integer", "null"] },
        list: { type: "array", items: { type: "number" } },
      },
      required: ["q"],
    },
  );
});
