import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { startHarness, StubSession, waitFor } from "./helpers.js";

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
  const h = await startHarness();
  try {
    const ws = await h.connect("?device=kitchen&x=1");
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
