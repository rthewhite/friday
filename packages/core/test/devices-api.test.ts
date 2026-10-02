import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import WebSocket from "ws";
import { ToolRegistry } from "@friday/sdk";
import { createApp } from "../src/app.js";
import { ModuleHost } from "../src/module-host.js";
import { McpSource } from "../src/tools/mcp.js";
import { attachAudioWs } from "../src/transports/ws.js";
import { fingerprint } from "../src/devices/store.js";
import { hashKey } from "../src/remote/key-store.js";
import { deviceFixture, StubSession, waitFor } from "./helpers.js";

const quiet = { log() {}, warn() {}, error() {} };
const newKey = () => randomBytes(32).toString("base64url");
const fp = (key: string) => fingerprint(hashKey(key));

/** Core's app and the audio transport on one server, sharing a device store and sessions as server.ts wires them. */
async function start(opts: { withStore?: boolean } = {}) {
  const fixture = deviceFixture();
  const registry = new ToolRegistry(quiet);
  const withStore = opts.withStore ?? true;
  const server = createServer(
    createApp({
      registry,
      host: new ModuleHost(registry, { env: {}, log: quiet }),
      mcp: new McpSource(registry, undefined, { log: quiet }),
      webDir: "/nonexistent",
      ...(withStore ? { devices: fixture.store, deviceSessions: fixture.sessions } : {}),
    }),
  );
  StubSession.instances = [];
  attachAudioWs(server, { pingMs: 0, devices: fixture.store, deviceSessions: fixture.sessions, createSession: (e, r, d) => new StubSession(e, r, d) });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(base + path, { method, headers: body === undefined ? {} : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : undefined };
  };
  /** A device dialling /ws/audio with its key. */
  const dial = (id: string, key: string) => new WebSocket(`ws://127.0.0.1:${port}/ws/audio?device=${id}`, { headers: { authorization: `Bearer ${key}` } });
  const close = async () => {
    server.closeAllConnections();
    server.close();
    await once(server, "close");
  };
  return { ...fixture, call, dial, close };
}

test("listing shows devices with status and pending attempts, never a key or hash", async () => {
  const s = await start();
  try {
    const key = s.register("friday-kitchen", { label: "Kitchen satellite", area: "Kitchen" });
    const other = newKey();
    s.store.authenticate("friday-hall", other);
    const { status, body } = await s.call("GET", "/api/devices");
    assert.equal(status, 200);
    assert.equal(body.devices.length, 1);
    assert.deepEqual(
      { id: body.devices[0].id, label: body.devices[0].label, area: body.devices[0].area, fingerprint: body.devices[0].fingerprint, connected: body.devices[0].connected, revoked: body.devices[0].revoked },
      { id: "friday-kitchen", label: "Kitchen satellite", area: "Kitchen", fingerprint: fp(key), connected: false, revoked: false },
    );
    assert.deepEqual(body.pending.map((p: { id: string; fingerprint: string; attempts: number }) => [p.id, p.fingerprint, p.attempts]), [["friday-hall", fp(other), 1]]);
    const json = JSON.stringify(body);
    for (const secret of [key, other, hashKey(key), hashKey(other)]) assert.ok(!json.includes(secret));
  } finally {
    await s.close();
  }
});

test("accepting a pending device registers it, and the device then gets a session and shows as connected", async () => {
  const s = await start();
  try {
    const key = newKey();
    const first = s.dial("friday-kitchen", key);
    const [code] = await once(first, "close");
    assert.equal(code, 4403);
    const accepted = await s.call("POST", "/api/devices/pending/friday-kitchen/accept", { fingerprint: fp(key), label: "Kitchen", area: "Kitchen", notes: "By the fridge" });
    assert.equal(accepted.status, 201);
    assert.equal(accepted.body.area, "Kitchen");
    const ws = s.dial("friday-kitchen", key);
    await once(ws, "open");
    await waitFor(() => StubSession.instances.length === 1);
    assert.equal((await s.call("GET", "/api/devices")).body.devices[0].connected, true);
    ws.close();
    await once(ws, "close");
  } finally {
    await s.close();
  }
});

test("errors: unknown attempt 404, stale fingerprint 409, already registered 409, invalid input 400 naming the field", async () => {
  const s = await start();
  try {
    assert.equal((await s.call("POST", "/api/devices/pending/nope/accept", { fingerprint: "0000-0000" })).status, 404);
    const key = s.register("friday-voice");
    const fresh = newKey();
    s.store.authenticate("friday-voice", fresh);
    const stale = await s.call("POST", "/api/devices/friday-voice/replace-key", { fingerprint: fp(key) });
    assert.equal(stale.status, 409);
    assert.equal((await s.call("POST", "/api/devices/pending/friday-voice/accept", { fingerprint: fp(fresh) })).status, 409, "already registered");
    assert.equal(s.store.authenticate("friday-voice", key).ok, true, "the stored key is unchanged");
    const bad = await s.call("PUT", "/api/devices/friday-voice", { notes: "x".repeat(1001) });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /notes/);
    assert.equal((await s.call("PUT", "/api/devices/friday-voice", { label: 7 })).body.error, "label must be a string");
    assert.equal((await s.call("PUT", "/api/devices/nope", { label: "x" })).status, 404);
    assert.equal((await s.call("PUT", "/api/devices/friday-voice", [1])).status, 400);
    assert.equal((await s.call("DELETE", "/api/devices/pending/nope")).status, 404);
    assert.equal((await s.call("POST", "/api/devices/nope/revoke")).status, 404);
    assert.equal((await s.call("DELETE", "/api/devices/nope")).status, 404);
  } finally {
    await s.close();
  }
});

test("replacing the key keeps the metadata and closes the session open with the old key", async () => {
  const s = await start();
  try {
    const old = s.register("friday-voice", { label: "Living room", area: "Living room" });
    const ws = s.dial("friday-voice", old);
    await once(ws, "open");
    await waitFor(() => StubSession.instances.length === 1);
    const fresh = newKey();
    s.store.authenticate("friday-voice", fresh);
    const closed = once(ws, "close");
    const r = await s.call("POST", "/api/devices/friday-voice/replace-key", { fingerprint: fp(fresh) });
    assert.equal(r.status, 200);
    assert.deepEqual([r.body.label, r.body.area, r.body.fingerprint], ["Living room", "Living room", fp(fresh)]);
    assert.equal((await closed)[0], 4401);
  } finally {
    await s.close();
  }
});

test("revoking closes the live socket with 4401, and deleting lets the device onboard again", async () => {
  const s = await start();
  try {
    const key = s.register("friday-kitchen");
    const ws = s.dial("friday-kitchen", key);
    await once(ws, "open");
    await waitFor(() => StubSession.instances.length === 1);
    const closed = once(ws, "close");
    const r = await s.call("POST", "/api/devices/friday-kitchen/revoke");
    assert.equal(r.status, 200);
    assert.equal(r.body.revoked, true);
    const [code, reason] = await closed;
    assert.equal(code, 4401);
    assert.equal(reason.toString(), "unauthorized");
    await waitFor(() => StubSession.instances[0].closed === 1);
    assert.equal((await s.call("GET", "/api/devices")).body.devices[0].connected, false);
    assert.equal((await s.call("DELETE", "/api/devices/friday-kitchen")).status, 204);
    const again = s.dial("friday-kitchen", key);
    assert.equal((await once(again, "close"))[0], 4403);
    assert.deepEqual((await s.call("GET", "/api/devices")).body.pending.map((p: { id: string }) => p.id), ["friday-kitchen"]);
  } finally {
    await s.close();
  }
});

test("ignoring and editing", async () => {
  const s = await start();
  try {
    s.store.authenticate("friday-hall", newKey());
    assert.equal((await s.call("DELETE", "/api/devices/pending/friday-hall")).status, 204);
    assert.deepEqual((await s.call("GET", "/api/devices")).body.pending, []);
    s.register("friday-kitchen", { area: "Kitchen" });
    const r = await s.call("PUT", "/api/devices/friday-kitchen", { area: "Living room", notes: "Moved" });
    assert.deepEqual([r.status, r.body.area, r.body.notes], [200, "Living room", "Moved"]);
  } finally {
    await s.close();
  }
});

test("without a device store the API answers 503", async () => {
  const s = await start({ withStore: false });
  try {
    assert.equal((await s.call("GET", "/api/devices")).status, 503);
    assert.equal((await s.call("POST", "/api/devices/x/revoke")).status, 503);
  } finally {
    await s.close();
  }
});
