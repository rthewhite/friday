import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { deviceFixture, sleep, startHarness, StubSession, waitFor } from "./helpers.js";
import { setup } from "./conversation-fixtures.js";

test("smoke: server starts and accepts a connection", async () => {
  const h = await startHarness();
  try {
    const ws = await h.connect();
    await waitFor(() => StubSession.instances.length === 1);
    ws.close();
    await once(ws, "close");
    await waitFor(() => StubSession.instances[0].closed === 1);
  } finally {
    await h.close();
  }
});

test("device query parameter is logged and unknown parameters are ignored", async () => {
  const devices = deviceFixture();
  const key = devices.register("kitchen");
  const h = await startHarness({ devices: devices.store });
  try {
    const ws = await h.connect("?device=kitchen&x=1", key);
    await waitFor(() => h.logs.some((l) => l.includes("[kitchen]") && l.includes("session open")));
    ws.close();
    await once(ws, "close");
    await waitFor(() => h.logs.some((l) => l.includes("[kitchen]") && l.includes("connection closed")));
  } finally {
    await h.close();
  }
});

test("connection without device parameter behaves as before", async () => {
  const h = await startHarness();
  try {
    const ws = await h.connect();
    await waitFor(() => h.logs.some((l) => l === "ws: session open"));
    ws.close();
    await once(ws, "close");
  } finally {
    await h.close();
  }
});

/** Say one exchange through the stub's recorder, as GeminiSession would, and return the stored conversation. */
async function recordOne(query: string) {
  const { store } = setup();
  const devices = deviceFixture();
  const key = devices.register("kitchen");
  const h = await startHarness({ conversations: store, devices: devices.store });
  try {
    const ws = await h.connect(query, query.includes("device=") ? key : undefined);
    await waitFor(() => StubSession.instances.length === 1);
    const r = StubSession.instances[0].recorder!;
    r.user(" Hi", "speech");
    r.assistant("Hello.");
    r.turnComplete();
    r.end("ended: no follow-up");
    ws.close();
    await once(ws, "close");
    return store.get(r.conversationId!)!;
  } finally {
    await h.close();
  }
}

test("the device query parameter is recorded with the connection's voice conversation", async () => {
  const c = await recordOne("?device=kitchen&x=1");
  assert.equal(c.channel, "voice");
  assert.equal(c.device, "kitchen");
  assert.equal(c.entryCount, 2);
  assert.equal(c.endReason, "ended: no follow-up");
});

test("a connection without device parameter records a conversation without device", async () => {
  const c = await recordOne("");
  assert.equal(c.device, null);
});

test("without a conversation store the session gets no recorder", async () => {
  const h = await startHarness();
  try {
    await h.connect();
    await waitFor(() => StubSession.instances.length === 1);
    assert.equal(StubSession.instances[0].recorder, undefined);
  } finally {
    await h.close();
  }
});

test("keep-alive: client that never pongs is terminated and its session closed", async () => {
  const h = await startHarness({ pingMs: 50 });
  try {
    const WebSocket = (await import("ws")).default;
    const ws = new WebSocket(h.url, { autoPong: false });
    await once(ws, "open");
    await waitFor(() => StubSession.instances.length === 1);
    const t0 = Date.now();
    await once(ws, "close");
    assert.ok(Date.now() - t0 < 1000, "terminated within a few ping intervals");
    await waitFor(() => StubSession.instances[0].closed === 1);
    assert.ok(h.logs.some((l) => l.includes("no pong")));
  } finally {
    await h.close();
  }
});

test("keep-alive: client that pongs stays connected across several intervals", async () => {
  const h = await startHarness({ pingMs: 30 });
  try {
    const ws = await h.connect();
    let pings = 0;
    ws.on("ping", () => pings++);
    await waitFor(() => pings >= 4, 2000);
    assert.equal(ws.readyState, ws.OPEN);
    assert.equal(StubSession.instances[0].closed, 0);
    ws.close();
    await once(ws, "close");
  } finally {
    await h.close();
  }
});

test("binary frames: 100 ms batches and a one second frame are forwarded intact", async () => {
  const h = await startHarness();
  try {
    const ws = await h.connect();
    await waitFor(() => StubSession.instances.length === 1);
    const s = StubSession.instances[0];
    const small = Buffer.alloc(3200, 1);
    for (let i = 0; i < 5; i++) ws.send(small);
    const big = Buffer.alloc(32000, 2);
    ws.send(big);
    await waitFor(() => s.audio.length === 6);
    assert.deepEqual(s.audio.slice(0, 5).map((b) => b.length), [3200, 3200, 3200, 3200, 3200]);
    assert.equal(s.audio[5].length, 32000);
    assert.ok(s.audio[5].equals(big));
    ws.close();
    await once(ws, "close");
  } finally {
    await h.close();
  }
});

test("text frame is forwarded as a user turn", async () => {
  const h = await startHarness();
  try {
    const ws = await h.connect();
    await waitFor(() => StubSession.instances.length === 1);
    ws.send(JSON.stringify({ type: "text", text: "hello" }));
    await waitFor(() => StubSession.instances[0].texts.length === 1);
    assert.equal(StubSession.instances[0].texts[0], "hello");
    ws.close();
    await once(ws, "close");
  } finally {
    await h.close();
  }
});

test("session events are relayed and closed event closes the socket", async () => {
  const h = await startHarness();
  try {
    const ws = await h.connect();
    await waitFor(() => StubSession.instances.length === 1);
    const s = StubSession.instances[0];
    const got: unknown[] = [];
    ws.on("message", (d, bin) => got.push(bin ? (d as Buffer).length : JSON.parse(d.toString())));
    s.emit({ kind: "audio", data: Buffer.alloc(480) });
    s.emit({ kind: "interrupted" });
    s.emit({ kind: "closed", data: "ended: done" });
    await once(ws, "close");
    assert.deepEqual(got, [480, { type: "interrupted" }, { type: "closed", data: "ended: done" }]);
  } finally {
    await h.close();
  }
});

test("gemini unavailable closes with 1011", async () => {
  const h = await startHarness();
  try {
    const orig = StubSession.prototype.open;
    StubSession.prototype.open = async function () { throw new Error("down"); };
    try {
      const ws = await h.connect();
      const [code, reason] = await once(ws, "close");
      assert.equal(code, 1011);
      assert.equal(reason.toString(), "gemini unavailable");
    } finally {
      StubSession.prototype.open = orig;
    }
  } finally {
    await h.close();
  }
});

// ---------------------------------------------------------------- device authentication

const randomKey = () => randomBytes(32).toString("base64url");

test("a registered device with its key gets a session that carries its device", async () => {
  const devices = deviceFixture();
  const key = devices.register("kitchen", { label: "Kitchen satellite", area: "Kitchen" });
  const h = await startHarness({ devices: devices.store, deviceSessions: devices.sessions });
  try {
    const ws = await h.connect("?device=kitchen", key);
    await waitFor(() => StubSession.instances.length === 1);
    assert.deepEqual(StubSession.instances[0].device, { id: "kitchen", label: "Kitchen satellite", area: "Kitchen", notes: null });
    assert.equal(devices.sessions.connected("kitchen"), true);
    assert.ok(devices.store.get("kitchen")!.lastSeenAt);
    ws.close();
    await once(ws, "close");
    await waitFor(() => !devices.sessions.connected("kitchen"));
  } finally {
    await h.close();
  }
});

test("a new device is closed with 4403, gets no session, and is recorded as pending", async () => {
  const devices = deviceFixture();
  const h = await startHarness({ devices: devices.store });
  try {
    assert.deepEqual(await h.rejected("?device=kitchen-2", randomKey()), { code: 4403, reason: "pending approval" });
    assert.equal(StubSession.instances.length, 0);
    assert.deepEqual(devices.store.list().pending.map((p) => p.id), ["kitchen-2"]);
  } finally {
    await h.close();
  }
});

test("a known device presenting another key is closed with 4403", async () => {
  const devices = deviceFixture();
  devices.register("kitchen");
  const h = await startHarness({ devices: devices.store });
  try {
    assert.equal((await h.rejected("?device=kitchen", randomKey())).code, 4403);
    assert.equal(StubSession.instances.length, 0);
    assert.ok(devices.store.get("kitchen")!.replacement);
  } finally {
    await h.close();
  }
});

test("a device connection without a key, or with the key only in the URL, is closed with 4401", async () => {
  const devices = deviceFixture();
  const key = devices.register("kitchen");
  const h = await startHarness({ devices: devices.store });
  try {
    assert.deepEqual(await h.rejected("?device=kitchen"), { code: 4401, reason: "unauthorized" });
    assert.deepEqual(await h.rejected(`?device=kitchen&key=${key}`), { code: 4401, reason: "unauthorized" });
    assert.equal(StubSession.instances.length, 0);
    assert.deepEqual(devices.store.list().pending, []);
  } finally {
    await h.close();
  }
});

test("a revoked device is closed with 4401 and not recorded as pending", async () => {
  const devices = deviceFixture();
  const key = devices.register("kitchen");
  devices.store.revoke("kitchen");
  const h = await startHarness({ devices: devices.store });
  try {
    assert.equal((await h.rejected("?device=kitchen", key)).code, 4401);
    assert.equal((await h.rejected("?device=kitchen", randomKey())).code, 4401);
    assert.deepEqual(devices.store.list().pending, []);
  } finally {
    await h.close();
  }
});

test("a malformed device id is closed with 4400", async () => {
  const devices = deviceFixture();
  const h = await startHarness({ devices: devices.store });
  try {
    assert.deepEqual(await h.rejected("?device=Kitchen!", randomKey()), { code: 4400, reason: "bad device" });
    assert.equal(StubSession.instances.length, 0);
  } finally {
    await h.close();
  }
});

test("without a device store every device connection is closed with 4401", async () => {
  const h = await startHarness();
  try {
    assert.equal((await h.rejected("?device=kitchen", randomKey())).code, 4401);
  } finally {
    await h.close();
  }
});

test("frames a rejected device sends before the close reach no session", async () => {
  const devices = deviceFixture();
  const h = await startHarness({ devices: devices.store });
  try {
    const WebSocket = (await import("ws")).default;
    const ws = new WebSocket(`${h.url}?device=kitchen-2`, { headers: { authorization: `Bearer ${randomKey()}` } });
    ws.on("open", () => ws.send(Buffer.alloc(3200)));
    const [code] = await once(ws, "close");
    assert.equal(code, 4403);
    await sleep(20);
    assert.equal(StubSession.instances.length, 0);
  } finally {
    await h.close();
  }
});

test("revoking a device closes its open connection with 4401 and ends its session", async () => {
  const devices = deviceFixture();
  const key = devices.register("kitchen");
  const h = await startHarness({ devices: devices.store, deviceSessions: devices.sessions });
  try {
    const ws = await h.connect("?device=kitchen", key);
    await waitFor(() => StubSession.instances.length === 1);
    const closed = once(ws, "close");
    devices.store.revoke("kitchen");
    devices.sessions.disconnect("kitchen");
    const [code, reason] = await closed;
    assert.equal(code, 4401);
    assert.equal(reason.toString(), "unauthorized");
    await waitFor(() => StubSession.instances[0].closed === 1);
  } finally {
    await h.close();
  }
});

test("a connection without a device needs no key, even when a device store is wired", async () => {
  const devices = deviceFixture();
  const h = await startHarness({ devices: devices.store, deviceSessions: devices.sessions });
  try {
    const ws = await h.connect();
    await waitFor(() => StubSession.instances.length === 1);
    assert.equal(StubSession.instances[0].device, undefined);
    ws.close();
    await once(ws, "close");
  } finally {
    await h.close();
  }
});
