import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { WebSocketServer, type WebSocket } from "ws";
import { defineModule, LlmError, OAuthError, type ModuleContext } from "../src/index.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { runRemote, CloseCode, SCHEDULING_META } from "../src/remote/index.js";
import { WsTransport } from "../src/remote/transport.js";
import { Type } from "../src/tool.js";

const quiet = { log() {}, warn() {}, error() {} };
const mod = defineModule({ manifest: { id: "m", label: "M" }, init(ctx) { ctx.defineTool({ name: "t", description: "", handler: () => ({}) }); } });

/** A fake core that records hellos and lets the test decide what to do with each socket. */
async function fakeCore(onHello: (ws: WebSocket, hello: any, n: number) => void) {
  const wss = new WebSocketServer({ port: 0 });
  await once(wss, "listening");
  let n = 0;
  wss.on("connection", (ws) => ws.once("message", (raw) => onHello(ws, JSON.parse(raw.toString()), ++n)));
  return { url: `ws://127.0.0.1:${(wss.address() as { port: number }).port}/ws/modules`, close: () => wss.close(), count: () => n };
}

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("sends a protocol-1 hello with key and manifest", async () => {
  let seen: any;
  const core = await fakeCore((ws, hello) => { seen = hello; ws.send(JSON.stringify({ type: "welcome", id: "m" })); });
  const h = runRemote(mod, { url: core.url, key: "k", log: quiet, env: {} });
  await h.connected();
  assert.deepEqual(seen, { type: "hello", key: "k", manifest: mod.manifest, protocol: 1 });
  await h.stop();
  core.close();
});

test("4401 is not retried", async () => {
  const core = await fakeCore((ws) => ws.close(CloseCode.UNAUTHORIZED, "unauthorized"));
  const h = runRemote(mod, { url: core.url, key: "bad", log: quiet, env: {}, minBackoffMs: 10, maxBackoffMs: 20 });
  await tick(300);
  assert.equal(core.count(), 1);
  await h.stop();
  core.close();
});

test("a network drop is retried with backoff and the module is re-announced", async () => {
  const core = await fakeCore((ws, _hello, n) => {
    ws.send(JSON.stringify({ type: "welcome", id: "m" }));
    if (n === 1) setTimeout(() => ws.terminate(), 20);
  });
  const h = runRemote(mod, { url: core.url, key: "k", log: quiet, env: {}, minBackoffMs: 10, maxBackoffMs: 20 });
  await h.connected();
  const t0 = Date.now();
  while (core.count() < 2 && Date.now() - t0 < 2000) await tick(10);
  assert.equal(core.count(), 2);
  await h.connected();
  await h.stop();
  core.close();
});

test("stop disposes the module and stops reconnecting", async () => {
  let disposed = 0;
  const m = defineModule({ manifest: { id: "m", label: "M" }, init() {}, dispose: () => void disposed++ });
  const core = await fakeCore((ws) => ws.send(JSON.stringify({ type: "welcome", id: "m" })));
  const h = runRemote(m, { url: core.url, key: "k", log: quiet, env: {}, minBackoffMs: 10 });
  await h.connected();
  await h.stop();
  const n = core.count();
  await tick(100);
  assert.equal(core.count(), n);
  assert.equal(disposed, 1);
  core.close();
});

test("ctx.jobs.schedule throws on the remote runner", async () => {
  let err: unknown;
  const m = defineModule({ manifest: { id: "m", label: "M" }, init(ctx) { try { ctx.jobs.schedule({ name: "nightly", cron: "0 3 * * *", run() {} }); } catch (e) { err = e; } } });
  const core = await fakeCore((ws) => ws.send(JSON.stringify({ type: "welcome", id: "m" })));
  const h = runRemote(m, { url: core.url, key: "k", log: quiet, env: {} });
  await h.connected();
  assert.match(String(err), /m: jobs are not available in this host/);
  await h.stop();
  core.close();
});

test("ctx.llm is unavailable to remote modules", async () => {
  let ctx: ModuleContext | undefined;
  const m = defineModule({ manifest: { id: "m", label: "M" }, init: (c) => void (ctx = c) });
  const core = await fakeCore((ws) => ws.send(JSON.stringify({ type: "welcome", id: "m" })));
  const h = runRemote(m, { url: core.url, key: "k", log: quiet, env: {} });
  await h.connected();
  await assert.rejects(ctx!.llm.generate({ prompt: "hi" }), (e) => {
    assert.ok(e instanceof LlmError);
    assert.equal(e.kind, "unavailable");
    assert.equal(e.message, "text generation is not available in this host");
    return true;
  });
  await h.stop();
  core.close();
});

test("ctx.oauth rejects in remote modules with not_connected", async () => {
  let ctx: ModuleContext | undefined;
  const m = defineModule({ manifest: { id: "m", label: "M", oauth: [{ provider: "spotify", scopes: [] }] }, init: (c) => void (ctx = c) });
  const core = await fakeCore((ws) => ws.send(JSON.stringify({ type: "welcome", id: "m" })));
  const h = runRemote(m, { url: core.url, key: "k", log: quiet, env: {} });
  await h.connected();
  await assert.rejects(ctx!.oauth.token("spotify"), (e) => {
    assert.ok(e instanceof OAuthError);
    assert.equal(e.kind, "not_connected");
    assert.equal(e.message, "OAuth connections are not available in this host");
    return true;
  });
  await h.stop();
  core.close();
});

test("conversations and users are not available to remote modules", async () => {
  let ctx: ModuleContext | undefined;
  const m = defineModule({ manifest: { id: "m", label: "M" }, init(c) { ctx = c; } });
  const core = await fakeCore((ws) => ws.send(JSON.stringify({ type: "welcome", id: "m" })));
  const h = runRemote(m, { url: core.url, key: "k", log: quiet, env: {}, minBackoffMs: 10 });
  await h.connected();
  const view = ctx!.conversations.forUser("u1");
  await assert.rejects(view.list(), /m: conversations are not available in this host/);
  await assert.rejects(view.get("x"), /conversations are not available in this host/);
  await assert.rejects(view.search({ query: "boiler" }), /m: conversations are not available in this host/);
  assert.throws(() => ctx!.conversations.onQuiet(() => {}), /conversations are not available in this host/);
  assert.throws(() => ctx!.users.owner(), /m: users are not available in this host/);
  assert.throws(() => ctx!.users.list(), /m: users are not available in this host/);
  assert.throws(() => ctx!.users.onOwner(() => {}), /m: users are not available in this host/);
  await h.stop();
  core.close();
});

test("a module with migrations runs remotely; ctx.db and ctx.prompt are unavailable", async () => {
  let ctx: ModuleContext | undefined;
  const warnings: string[] = [];
  const m = defineModule({
    manifest: { id: "m", label: "M" },
    migrations: [{ version: 1, name: "items", up: "CREATE TABLE m__items (id INTEGER PRIMARY KEY)" }],
    init(c) { ctx = c; c.defineTool({ name: "t", description: "", handler: () => ({}) }); },
  });
  const core = await fakeCore((ws) => ws.send(JSON.stringify({ type: "welcome", id: "m" })));
  const h = runRemote(m, { url: core.url, key: "k", log: { ...quiet, warn: (...a: unknown[]) => void warnings.push(a.join(" ")) }, env: {} });
  await h.connected();
  assert.deepEqual(warnings, ["remote m: ignoring 1 declared migration(s); remote modules have no database"]);
  assert.throws(() => ctx!.db.prepare("SELECT 1"), { message: "m: database is not available in this host" });
  assert.throws(() => ctx!.db.exec("SELECT 1"), /m: database is not available in this host/);
  assert.throws(() => ctx!.db.transaction(() => 1), /m: database is not available in this host/);
  assert.throws(() => ctx!.prompt.addContext(() => "x"), { message: "m: prompt context is not available in this host" });
  await h.stop();
  core.close();
});

test("a welcome that isn't JSON, or isn't a welcome, closes with 4000 and is retried", async () => {
  const closes: string[] = [];
  const core = await fakeCore((ws, _hello, n) => {
    ws.on("close", (code, reason) => closes.push(`${code} ${reason}`));
    if (n === 1) ws.send("not json");
    else if (n === 2) ws.send(JSON.stringify({ type: "hello" }));
    else ws.send(JSON.stringify({ type: "welcome", id: "m" }));
  });
  const h = runRemote(mod, { url: core.url, key: "k", log: quiet, env: {}, minBackoffMs: 5, maxBackoffMs: 10 });
  await h.connected();
  assert.deepEqual(closes, ["4000 bad welcome", "4000 expected welcome"]);
  assert.equal(core.count(), 3);
  await h.stop();
  core.close();
});

test("a socket error is logged and the runner keeps retrying", { timeout: 5000 }, async () => {
  // A port nobody listens on: the connection is refused.
  const probe = new WebSocketServer({ port: 0 });
  await once(probe, "listening");
  const url = `ws://127.0.0.1:${(probe.address() as { port: number }).port}/ws/modules`;
  await new Promise((r) => probe.close(r));
  const errors: string[] = [];
  const h = runRemote(mod, { url, key: "k", log: { ...quiet, error: (m: string) => void errors.push(m) }, env: {}, minBackoffMs: 5, maxBackoffMs: 10 });
  while (errors.length < 2) await tick(5);
  assert.match(errors[0]!, /^remote m: .*ECONNREFUSED/);
  await h.stop();
});

test("no welcome within the hello timeout closes with 4000 and is retried", async () => {
  const closes: string[] = [];
  const core = await fakeCore((ws, _hello, n) => {
    ws.on("close", (code, reason) => closes.push(`${code} ${reason}`));
    if (n > 1) ws.send(JSON.stringify({ type: "welcome", id: "m" }));
  });
  const h = runRemote(mod, { url: core.url, key: "k", log: quiet, env: {}, helloTimeoutMs: 30, minBackoffMs: 5, maxBackoffMs: 10 });
  await h.connected();
  assert.deepEqual(closes, ["4000 no welcome"]);
  await h.stop();
  core.close();
});

test("core lists and calls the module's tools over MCP on the socket", async () => {
  let late: ModuleContext | undefined;
  const tools = defineModule({
    manifest: { id: "m", label: "M" },
    init(ctx) {
      late = ctx;
      ctx.defineTool<{ room: string }>({
        name: "temp",
        description: "Room temperature",
        parameters: { type: Type.OBJECT, properties: { room: { type: Type.STRING } }, required: ["room"] },
        handler: ({ room }) => ({ room, c: 21 }),
      });
      ctx.defineTool({ name: "bye", description: "", parametersJsonSchema: { type: "object", properties: {} }, scheduling: "SILENT", handler: () => ({ ok: true, endConversation: "done" }) });
      ctx.defineTool({ name: "broken", description: "", handler: () => ({ error: "unavailable" }) });
    },
  });
  // Core's side: welcome the runner, then talk MCP to it over the same socket.
  let connected!: (c: Client) => void;
  const ready = new Promise<Client>((r) => (connected = r));
  const core = await fakeCore(async (ws) => {
    ws.send(JSON.stringify({ type: "welcome", id: "m" }));
    const c = new Client({ name: "core", version: "0" });
    await c.connect(new WsTransport(ws));
    connected(c);
  });
  const h = runRemote(tools, { url: core.url, key: "k", log: quiet, env: {} });
  const client = await ready;
  try {
    const listed = (await client.listTools()).tools;
    assert.deepEqual(listed.map((t) => [t.name, t.description, t._meta?.[SCHEDULING_META]]), [
      ["temp", "Room temperature", "INTERRUPT"],
      ["bye", "", "SILENT"],
      ["broken", "", "INTERRUPT"],
    ]);
    assert.deepEqual(listed[0]!.inputSchema, { type: "object", properties: { room: { type: "string" } }, required: ["room"] });
    assert.deepEqual(listed[1]!.inputSchema, { type: "object", properties: {} });

    const temp = await client.callTool({ name: "temp", arguments: { room: "kitchen" } });
    assert.deepEqual([temp.structuredContent, temp.isError], [{ room: "kitchen", c: 21, scheduling: "INTERRUPT" }, false]);
    const bye = await client.callTool({ name: "bye", arguments: {} });
    assert.deepEqual(bye.structuredContent, { ok: true, scheduling: "SILENT", endConversation: "done" });
    const broken = await client.callTool({ name: "broken", arguments: {} });
    assert.deepEqual([broken.structuredContent, broken.isError], [{ error: "unavailable", scheduling: "INTERRUPT" }, true]);

    // A tool added later is announced, so core can list again.
    const changed = new Promise<void>((r) => client.setNotificationHandler(ToolListChangedNotificationSchema, async () => r()));
    late!.defineTool({ name: "late", description: "", handler: () => ({}) });
    await changed;
    assert.ok((await client.listTools()).tools.some((t) => t.name === "late"));
  } finally {
    await client.close();
    await h.stop();
    core.close();
  }
});
