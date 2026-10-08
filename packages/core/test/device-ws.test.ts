import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import WebSocket from "ws";
import { attachDeviceWs, type DeviceReport } from "../src/transports/device-ws.js";
import { DeviceLinks } from "../src/devices/links.js";
import type { DeviceStore } from "../src/devices/store.js";
import { deviceFixture, sleep, waitFor } from "./helpers.js";

const randomKey = () => randomBytes(32).toString("base64url");
const auth = (key?: string) => (key === undefined ? undefined : { headers: { authorization: `Bearer ${key}` } });

async function harness(opts: { devices?: Pick<DeviceStore, "authenticate">; pingMs?: number } = {}) {
  const logs: string[] = [];
  const origLog = console.log, origErr = console.error;
  console.log = (...a) => logs.push(a.map(String).join(" "));
  console.error = (...a) => logs.push(a.map(String).join(" "));
  const links = new DeviceLinks();
  const reports: [string, DeviceReport, string][] = [];
  const server = createServer();
  const wss = attachDeviceWs(server, { pingMs: 0, ...opts, links, onReport: (id, type, alert) => reports.push([id, type, alert]) });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `ws://127.0.0.1:${(server.address() as { port: number }).port}/ws/device`;
  return {
    links,
    reports,
    logs,
    async connect(query: string, key?: string, extra: object = {}) {
      const ws = new WebSocket(url + query, { ...auth(key), ...extra });
      await once(ws, "open");
      return ws;
    },
    async rejected(query: string, key?: string) {
      const ws = new WebSocket(url + query, auth(key));
      const [code, reason] = (await once(ws, "close")) as [number, Buffer];
      return { code, reason: reason.toString() };
    },
    async close() {
      for (const c of wss.clients) c.terminate();
      wss.close();
      server.close();
      await once(server, "close");
      console.log = origLog;
      console.error = origErr;
    },
  };
}

test("an accepted device stays connected without a session and counts as online until it disconnects", async () => {
  const devices = deviceFixture();
  const key = devices.register("friday-kitchen");
  const h = await harness({ devices: devices.store });
  try {
    const ws = await h.connect("?device=friday-kitchen", key);
    await waitFor(() => h.links.online("friday-kitchen"));
    assert.ok(devices.store.get("friday-kitchen")!.lastSeenAt, "the connection counts as the device's last connection");
    await sleep(50);
    assert.equal(ws.readyState, ws.OPEN);
    ws.close();
    await once(ws, "close");
    await waitFor(() => !h.links.online("friday-kitchen"));
  } finally {
    await h.close();
  }
});

test("a ring sent through the links arrives as a JSON text frame", async () => {
  const devices = deviceFixture();
  const key = devices.register("friday-kitchen");
  const h = await harness({ devices: devices.store });
  try {
    const ws = await h.connect("?device=friday-kitchen", key);
    await waitFor(() => h.links.online("friday-kitchen"));
    const got = once(ws, "message");
    h.links.send("friday-kitchen", { type: "ring", data: { alert: "k3f9" } });
    const [raw, isBinary] = (await got) as [Buffer, boolean];
    assert.equal(isBinary, false);
    assert.deepEqual(JSON.parse(raw.toString()), { type: "ring", data: { alert: "k3f9" } });
    ws.close();
  } finally {
    await h.close();
  }
});

test("an unregistered device is closed with 4403 and recorded as pending", async () => {
  const devices = deviceFixture();
  const h = await harness({ devices: devices.store });
  try {
    assert.deepEqual(await h.rejected("?device=friday-new", randomKey()), { code: 4403, reason: "pending approval" });
    assert.deepEqual(devices.store.list().pending.map((p) => p.id), ["friday-new"]);
    assert.equal(h.links.online("friday-new"), false);
  } finally {
    await h.close();
  }
});

test("missing key, revoked device, malformed id, no device parameter and no store are rejected like /ws/audio", async () => {
  const devices = deviceFixture();
  const key = devices.register("friday-kitchen");
  devices.register("friday-old");
  devices.store.revoke("friday-old");
  const h = await harness({ devices: devices.store });
  try {
    assert.deepEqual(await h.rejected("?device=friday-kitchen"), { code: 4401, reason: "unauthorized" });
    assert.deepEqual(await h.rejected(`?device=friday-kitchen&key=${key}`), { code: 4401, reason: "unauthorized" });
    assert.deepEqual(await h.rejected("?device=friday-old", randomKey()), { code: 4401, reason: "unauthorized" });
    assert.deepEqual(await h.rejected("?device=Kitchen!", key), { code: 4400, reason: "bad device" });
    assert.deepEqual(await h.rejected("", key), { code: 4400, reason: "bad device" });
  } finally {
    await h.close();
  }
  const bare = await harness();
  try {
    assert.equal((await bare.rejected("?device=friday-kitchen", key)).code, 4401);
  } finally {
    await bare.close();
  }
});

test("a device store error closes the connection with 1011", async () => {
  const h = await harness({ devices: { authenticate: () => { throw new Error("database is locked"); } } });
  try {
    assert.deepEqual(await h.rejected("?device=friday-kitchen", randomKey()), { code: 1011, reason: "internal error" });
  } finally {
    await h.close();
  }
});

test("a second control connection replaces the first with 4409", async () => {
  const devices = deviceFixture();
  const key = devices.register("friday-kitchen");
  const h = await harness({ devices: devices.store });
  try {
    const first = await h.connect("?device=friday-kitchen", key);
    await waitFor(() => h.links.online("friday-kitchen"));
    const closed = once(first, "close");
    const second = await h.connect("?device=friday-kitchen", key);
    const [code, reason] = (await closed) as [number, Buffer];
    assert.deepEqual([code, reason.toString()], [4409, "replaced"]);
    await sleep(20);
    assert.equal(h.links.online("friday-kitchen"), true, "the old socket closing leaves the new one online");
    const got = once(second, "message");
    h.links.send("friday-kitchen", { type: "stop", data: { alert: "k3f9" } });
    await got;
    second.close();
  } finally {
    await h.close();
  }
});

test("device reports reach the handler, malformed and binary frames are ignored and the connection stays open", async () => {
  const devices = deviceFixture();
  const key = devices.register("friday-kitchen");
  const h = await harness({ devices: devices.store });
  try {
    const ws = await h.connect("?device=friday-kitchen", key);
    for (const bad of ["{", "null", "7", JSON.stringify({ type: "ring", alert: "x" }), JSON.stringify({ type: "acknowledged" }), JSON.stringify({ type: "acknowledged", alert: 7 })])
      ws.send(bad);
    ws.send(Buffer.from([1, 2, 3]));
    ws.send(JSON.stringify({ type: "ringing_locally", alert: "k3f9" }));
    ws.send(JSON.stringify({ type: "acknowledged", alert: "k3f9" }));
    ws.send(JSON.stringify({ type: "unanswered", alert: "zz22" }));
    await waitFor(() => h.reports.length === 3);
    assert.deepEqual(h.reports, [
      ["friday-kitchen", "ringing_locally", "k3f9"],
      ["friday-kitchen", "acknowledged", "k3f9"],
      ["friday-kitchen", "unanswered", "zz22"],
    ]);
    assert.equal(ws.readyState, ws.OPEN);
    ws.close();
  } finally {
    await h.close();
  }
});

test("keep-alive: a device that never pongs is terminated and goes offline", async () => {
  const devices = deviceFixture();
  const key = devices.register("friday-kitchen");
  const h = await harness({ devices: devices.store, pingMs: 50 });
  try {
    const ws = await h.connect("?device=friday-kitchen", key, { autoPong: false });
    await waitFor(() => h.links.online("friday-kitchen"));
    const t0 = Date.now();
    await once(ws, "close");
    assert.ok(Date.now() - t0 < 1000, "terminated within a few ping intervals");
    await waitFor(() => !h.links.online("friday-kitchen"));
  } finally {
    await h.close();
  }
});
