import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import WebSocket from "ws";
import { defineModule, ToolRegistry } from "@friday/sdk";
import { runRemote, WsTransport } from "@friday/sdk/remote";
import builtin from "@friday/module-builtin";
import { createTestHost } from "@friday/sdk/test";
import { createApp } from "../src/app.js";
import { ModuleHost } from "../src/module-host.js";
import { EnvKeyStore } from "../src/remote/key-store.js";
import { RemoteHost } from "../src/remote/host.js";
import { McpSource } from "../src/tools/mcp.js";
import { waitFor } from "./helpers.js";

const quiet = { log() {}, warn() {}, error() {} };

async function core(opts: { keys?: string; pingMs?: number; helloTimeoutMs?: number; callTimeoutMs?: number } = {}) {
  const logs: string[] = [];
  const log = { log: (...a: unknown[]) => logs.push(a.join(" ")), warn: (...a: unknown[]) => logs.push("warn " + a.join(" ")), error: (...a: unknown[]) => logs.push("error " + a.join(" ")) };
  const registry = new ToolRegistry(quiet);
  const host = new ModuleHost(registry, { env: {}, log: quiet });
  const mcp = new McpSource(registry, undefined, { log: quiet });
  const remote = new RemoteHost({ registry, keys: new EnvKeyStore(opts.keys ?? "sim=secret,other=o"), pingMs: opts.pingMs ?? 0, helloTimeoutMs: opts.helloTimeoutMs, callTimeoutMs: opts.callTimeoutMs, log });
  const server = createServer(createApp({ registry, host, mcp, remote, webDir: "/nonexistent" }));
  remote.attach(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  return {
    registry, remote, logs,
    url: `ws://127.0.0.1:${port}/ws/modules`,
    http: `http://127.0.0.1:${port}`,
    async raw() { const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/modules`); await once(ws, "open"); return ws; },
    async close() { await remote.closeAll(); server.close(); await once(server, "close"); },
  };
}

const manifest = { id: "sim", label: "Sim" };
const hello = (over: Record<string, unknown> = {}) => JSON.stringify({ type: "hello", key: "secret", manifest, protocol: 1, ...over });

async function closeCode(ws: WebSocket): Promise<number> {
  const [code] = await once(ws, "close");
  return code as number;
}

test("handshake close codes: 4408 no hello, 4400 malformed/protocol, 4401 unknown key or id mismatch", async () => {
  const c = await core({ helloTimeoutMs: 50 });
  try {
    assert.equal(await closeCode(await c.raw()), 4408);
    let ws = await c.raw(); ws.send("not json"); assert.equal(await closeCode(ws), 4400);
    ws = await c.raw(); ws.send(JSON.stringify({ type: "hi" })); assert.equal(await closeCode(ws), 4400);
    ws = await c.raw(); ws.send(hello({ protocol: 2 })); assert.equal(await closeCode(ws), 4400);
    ws = await c.raw(); ws.send(hello({ manifest: { id: "Bad Id", label: "x" } })); assert.equal(await closeCode(ws), 4400);
    ws = await c.raw(); ws.send(hello({ key: "wrong" })); assert.equal(await closeCode(ws), 4401);
    ws = await c.raw(); ws.send(hello({ key: "o" })); assert.equal(await closeCode(ws), 4401);
    assert.deepEqual(c.remote.connected(), []);
  } finally {
    await c.close();
  }
});

test("without keys every hello is rejected and startup warns", async () => {
  const c = await core({ keys: "" });
  try {
    assert.ok(c.logs.some((l) => l.includes("remote modules disabled")));
    const ws = await c.raw(); ws.send(hello());
    assert.equal(await closeCode(ws), 4401);
  } finally {
    await c.close();
  }
});

/** A hand-rolled remote so tests control the MCP server precisely. */
async function rawRemote(c: Awaited<ReturnType<typeof core>>, tools: Array<{ name: string; meta?: string; handler: (a: any) => unknown | Promise<unknown> }>) {
  const ws = await c.raw();
  // Construct the transport in the welcome handler, synchronously, so core's first MCP request is buffered.
  const welcomed = new Promise<WsTransport>((resolve) =>
    ws.once("message", (raw) => {
      assert.deepEqual(JSON.parse(raw.toString()), { type: "welcome", id: "sim" });
      resolve(new WsTransport(ws));
    }),
  );
  ws.send(hello());
  const transport = await welcomed;
  const server = new Server({ name: "sim", version: "0" }, { capabilities: { tools: { listChanged: true } } });
  const list = { tools };
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: list.tools.map((t) => ({ name: t.name, description: "d", inputSchema: { type: "object" }, _meta: t.meta ? { "friday/scheduling": t.meta } : undefined })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    const out = await list.tools.find((t) => t.name === params.name)!.handler(params.arguments);
    return { content: [{ type: "text", text: JSON.stringify(out) }], structuredContent: out as Record<string, unknown> };
  });
  await server.connect(transport);
  return { ws, server, list };
}

test("a remote call forwards only the tool's arguments, never the call context", async () => {
  const c = await core();
  try {
    const received: unknown[] = [];
    await rawRemote(c, [{ name: "pit", handler: (a) => (received.push(a), { ok: true }) }]);
    await waitFor(() => c.registry.names().length === 1);
    await c.registry.callTool("sim__pit", { lap: 12 }, { channel: "voice", conversationId: "c1" });
    assert.deepEqual(received, [{ lap: 12 }]);
  } finally {
    await c.close();
  }
});

test("registration, call forwarding, scheduling metadata, timeout and list_changed", async () => {
  const c = await core({ callTimeoutMs: 100 });
  try {
    const r = await rawRemote(c, [
      { name: "get position", meta: "WHEN_IDLE", handler: (a) => ({ pos: 3, car: a.car }) },
      { name: "slow", handler: () => new Promise(() => {}) },
    ]);
    await waitFor(() => c.registry.names().length === 2);
    assert.deepEqual(c.registry.list(), [
      { name: "sim__get_position", owner: "remote:sim", description: "d" },
      { name: "sim__slow", owner: "remote:sim", description: "d" },
    ]);
    // Remote tools carry no channels, so both voice and chat are offered them.
    assert.equal(c.registry.get("sim__slow")!.channels, undefined);
    assert.deepEqual(c.registry.declarations("chat").map((d) => d.name), ["sim__get_position", "sim__slow"]);
    assert.deepEqual(c.registry.declarations("voice").map((d) => d.name), ["sim__get_position", "sim__slow"]);
    assert.deepEqual(await c.registry.callTool("sim__get_position", { car: 7 }), { result: { pos: 3, car: 7 }, scheduling: "WHEN_IDLE" });
    assert.deepEqual(await c.registry.callTool("sim__slow", {}), { result: { error: "timeout" }, scheduling: "INTERRUPT" });

    r.list.tools = [{ name: "pit", handler: () => ({ ok: true }) }];
    await r.server.sendToolListChanged();
    await waitFor(() => c.registry.names().join() === "sim__pit");
    assert.deepEqual(await c.registry.callTool("sim__pit", {}), { result: { ok: true }, scheduling: "INTERRUPT" });

    const mods = await (await fetch(`${c.http}/api/modules`)).json();
    assert.equal(mods[0].id, "sim");
    assert.equal(mods[0].status, "connected");
    assert.deepEqual(mods[0].tools, ["sim__pit"]);
    assert.match(mods[0].connectedAt, /^\d{4}-/);

    r.ws.close();
    await waitFor(() => c.registry.names().length === 0);
    await waitFor(() => c.remote.connected().length === 0);
    assert.deepEqual(await (await fetch(`${c.http}/api/modules`)).json(), []);
  } finally {
    await c.close();
  }
});

test("a second connection for the same id replaces the first with 4409", async () => {
  const c = await core();
  try {
    const a = await rawRemote(c, [{ name: "a", handler: () => ({}) }]);
    await waitFor(() => c.registry.names().join() === "sim__a");
    const closed = closeCode(a.ws);
    const b = await rawRemote(c, [{ name: "b", handler: () => ({}) }]);
    assert.equal(await closed, 4409);
    await waitFor(() => c.registry.names().join() === "sim__b");
    assert.equal(c.remote.connected().length, 1);
    b.ws.close();
    await waitFor(() => c.registry.names().length === 0);
  } finally {
    await c.close();
  }
});

test("keep-alive terminates a remote that stops answering pings and removes its tools", async () => {
  const c = await core({ pingMs: 40 });
  try {
    const ws = new WebSocket(c.url, { autoPong: false });
    await once(ws, "open");
    const welcomed = new Promise<WsTransport>((r) => ws.once("message", () => r(new WsTransport(ws))));
    ws.send(hello());
    const server = new Server({ name: "sim", version: "0" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: "x", description: "", inputSchema: { type: "object" } }] }));
    await server.connect(await welcomed);
    await waitFor(() => c.registry.names().length === 1);
    await once(ws, "close");
    await waitFor(() => c.registry.names().length === 0);
  } finally {
    await c.close();
  }
});

test("shutdown closes remotes with 1001", async () => {
  const c = await core();
  const r = await rawRemote(c, [{ name: "a", handler: () => ({}) }]);
  await waitFor(() => c.registry.names().length === 1);
  const closed = closeCode(r.ws);
  await c.close();
  assert.equal(await closed, 1001);
});

test("integration: the builtin module run through runRemote matches in-process results", async () => {
  const c = await core({ keys: "builtin=k" });
  const remoteHandle = runRemote(builtin, { url: c.url, key: "k", env: { FRIDAY_TIMEZONE: "Asia/Tokyo" }, log: quiet });
  try {
    await remoteHandle.connected();
    await waitFor(() => c.registry.names().length === 2);
    assert.deepEqual(c.registry.names(), ["builtin__get_current_time", "builtin__end_conversation"]);

    const local = await createTestHost(builtin, { env: { FRIDAY_TIMEZONE: "Asia/Tokyo" } });
    const viaRemote = await c.registry.callTool("builtin__get_current_time", {});
    const inProcess = await local.call("get_current_time", {});
    assert.equal(viaRemote.result.timezone, inProcess.result.timezone);
    assert.equal(viaRemote.scheduling, inProcess.scheduling);

    // The tool's default scheduling (SILENT) and the reserved endConversation key survive the remote hop.
    const end = await c.registry.callTool("builtin__end_conversation", { reason: "bye" });
    assert.deepEqual(end, { result: { ending: true, reason: "bye" }, scheduling: "SILENT", endConversation: "bye" });

    const decl = c.registry.declarations().find((d) => d.name === "builtin__end_conversation")!;
    assert.equal((decl.parametersJsonSchema as any).properties.reason.type, "string");
  } finally {
    await remoteHandle.stop();
    await waitFor(() => c.registry.names().length === 0);
    await c.close();
  }
});

test("a module with a reserved-key result works remotely: scheduling override survives", async () => {
  const c = await core();
  const m = defineModule({ manifest, init(ctx) { ctx.defineTool({ name: "q", description: "", handler: () => ({ v: 1, scheduling: "SILENT" }) }); } });
  const h = runRemote(m, { url: c.url, key: "secret", env: {}, log: quiet });
  try {
    await h.connected();
    await waitFor(() => c.registry.names().length === 1);
    assert.deepEqual(await c.registry.callTool("sim__q", {}), { result: { v: 1 }, scheduling: "SILENT" });
  } finally {
    await h.stop();
    await c.close();
  }
});
