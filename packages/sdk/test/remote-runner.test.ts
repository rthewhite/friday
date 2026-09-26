import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { WebSocketServer, type WebSocket } from "ws";
import { defineModule } from "../src/index.js";
import { runRemote, CloseCode } from "../src/remote/index.js";

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
