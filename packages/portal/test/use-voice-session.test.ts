import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { useVoiceSession } from "../src/composables/useVoiceSession.ts";

// ---- fakes for the browser APIs the Talk page uses -------------------------------------------------------------

class FakeSource {
  buffer: { duration: number } | null = null;
  startedAt?: number;
  stopped = false;
  onended: (() => void) | null = null;
  connect() {}
  start(at: number) { this.startedAt = at; }
  stop() { this.stopped = true; }
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  currentTime = 0;
  destination = {};
  modules: string[] = [];
  sources: FakeSource[] = [];
  closed = false;
  audioWorklet = { addModule: async (url: string) => void this.modules.push(url) };
  constructor() { FakeAudioContext.instances.push(this); }
  createBuffer(_channels: number, length: number, rate: number) {
    const data = new Float32Array(length);
    return { duration: length / rate, getChannelData: () => data, data };
  }
  createBufferSource() { const s = new FakeSource(); this.sources.push(s); return s; }
  createMediaStreamSource() { return { connect() {} }; }
  async close() { this.closed = true; }
}

class FakeWorkletNode {
  static last: FakeWorkletNode | undefined;
  port: { onmessage: ((e: { data: ArrayBuffer }) => void) | null } = { onmessage: null };
  disconnected = false;
  constructor() { FakeWorkletNode.last = this; }
  disconnect() { this.disconnected = true; }
}

class FakeWebSocket {
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];
  static failNext = false;
  readyState = 0;
  binaryType = "blob";
  sent: ArrayBuffer[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
    const fail = FakeWebSocket.failNext;
    FakeWebSocket.failNext = false;
    setImmediate(() => (fail ? this.onerror?.() : ((this.readyState = 1), this.onopen?.())));
  }
  send(d: ArrayBuffer) { this.sent.push(d); }
  close() { this.closed = true; this.readyState = 3; }
  /** The server's side: a JSON event or a PCM frame. */
  event(type: string, data?: unknown) { this.onmessage?.({ data: JSON.stringify({ type, data }) }); }
  audio(samples: number) { this.onmessage?.({ data: new Int16Array(samples).buffer }); }
}

const tracks: { stopped: boolean }[] = [];
let micError: Error | undefined;
const saved: Record<string, PropertyDescriptor | undefined> = {};
const fakes: Record<string, unknown> = {
  AudioContext: FakeAudioContext,
  AudioWorkletNode: FakeWorkletNode,
  WebSocket: FakeWebSocket,
  location: { protocol: "http:", host: "friday.local:5173" },
  navigator: {
    mediaDevices: {
      getUserMedia: async () => {
        if (micError) throw micError;
        const track = { stopped: false, stop() { this.stopped = true; } };
        tracks.push(track);
        return { getTracks: () => [track] };
      },
    },
  },
};
const realWarn = console.warn, realError = console.error;

beforeEach(() => {
  for (const [k, v] of Object.entries(fakes)) {
    saved[k] = Object.getOwnPropertyDescriptor(globalThis, k);
    Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  }
  FakeAudioContext.instances = [];
  FakeWebSocket.instances = [];
  tracks.length = 0;
  micError = undefined;
  // onBeforeUnmount outside a component only warns; toggle() logs the errors it shows.
  console.warn = () => {};
  console.error = () => {};
});
afterEach(() => {
  for (const [k, d] of Object.entries(saved)) {
    if (d) Object.defineProperty(globalThis, k, d);
    else delete (globalThis as Record<string, unknown>)[k];
  }
  console.warn = realWarn;
  console.error = realError;
});

async function live() {
  const v = useVoiceSession();
  const starting = v.toggle();
  assert.equal(v.state.value, "connecting");
  await starting;
  const ws = FakeWebSocket.instances.at(-1)!;
  const ctx = FakeAudioContext.instances.at(-1)!;
  return { v, ws, ctx };
}

// ---- tests ------------------------------------------------------------------------------------------------------

test("toggle opens /ws/audio on this host, loads the capture worklet and sends the microphone's frames", async () => {
  const { v, ws, ctx } = await live();
  assert.deepEqual([v.state.value, v.live.value], ["live", true]);
  assert.equal(ws.url, "ws://friday.local:5173/ws/audio");
  assert.equal(ws.binaryType, "arraybuffer");
  assert.deepEqual(ctx.modules, ["/capture-worklet.js"]);
  const frame = new ArrayBuffer(640);
  FakeWorkletNode.last!.port.onmessage!({ data: frame });
  assert.deepEqual(ws.sent, [frame]);
  ws.readyState = 3;
  FakeWorkletNode.last!.port.onmessage!({ data: new ArrayBuffer(640) });
  assert.equal(ws.sent.length, 1, "nothing is sent on a closed socket");
});

test("on https the socket is wss", async () => {
  (globalThis as unknown as { location: object }).location = { protocol: "https:", host: "friday.example" };
  const { ws } = await live();
  assert.equal(ws.url, "wss://friday.example/ws/audio");
});

test("transcripts build one entry per speaker turn, and tool events get their own entries", async () => {
  const { v, ws } = await live();
  ws.event("user_text", "What's the ");
  ws.event("user_text", "weather?");
  ws.event("tool_call", { name: "weather", args: { city: "Utrecht" } });
  ws.event("tool_result", { name: "weather", result: { c: 12 } });
  ws.event("bot_text", "It's 12 ");
  ws.event("bot_text", "degrees.");
  ws.event("turn_complete");
  ws.event("user_text", "Thanks");
  assert.deepEqual(v.log.value.map((e) => [e.kind, e.text]), [
    ["user", "What's the weather?"],
    ["tool", '→ weather({"city":"Utrecht"})'],
    ["tool", '← weather: {"c":12}'],
    ["bot", "It's 12 degrees."],
    ["user", "Thanks"],
  ]);
});

test("audio plays back to back, and interrupted drops what is queued and starts a new bot entry", async () => {
  const { v, ws, ctx } = await live();
  ws.audio(24000); // one second at 24 kHz
  ws.audio(12000);
  assert.deepEqual(ctx.sources.map((s) => s.startedAt), [0.02, 1.02], "gapless: the second starts where the first ends");
  ws.event("bot_text", "Let me tell you a long");
  ws.event("interrupted");
  assert.ok(ctx.sources.every((s) => s.stopped), "queued audio is stopped");
  ctx.currentTime = 5;
  ws.audio(2400);
  assert.equal(ctx.sources.at(-1)!.startedAt, 5.02, "playback starts afresh after an interruption");
  ws.event("bot_text", "Sure.");
  assert.deepEqual(v.log.value.filter((e) => e.kind === "bot").map((e) => e.text), ["Let me tell you a long", "Sure."]);
});

test("a refused microphone or a failed socket shows an error state and releases everything", async () => {
  micError = Object.assign(new Error("Permission denied"), { name: "NotAllowedError" });
  const a = useVoiceSession();
  await a.toggle();
  assert.deepEqual([a.state.value, a.live.value], ["error: Permission denied", false]);
  assert.equal(FakeWebSocket.instances.length, 0, "no socket without a microphone");

  micError = undefined;
  FakeWebSocket.failNext = true;
  const b = useVoiceSession();
  await b.toggle();
  assert.equal(b.state.value, "error: websocket failed");
  assert.ok(tracks.every((t) => t.stopped), "the microphone is released");
});

test("the server closing the session stops the microphone at once but lets queued speech finish", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { v, ws, ctx } = await live();
  ws.audio(48000); // two seconds of speech queued
  ws.event("closed", "ended: request done");
  assert.deepEqual([v.state.value, v.live.value], ["idle", false]);
  assert.equal(v.log.value.at(-1)!.text, "session closed: ended: request done");
  assert.ok(tracks.every((tr) => tr.stopped) && FakeWorkletNode.last!.disconnected && ws.closed);
  assert.equal(ctx.sources[0]!.stopped, false, "queued speech keeps playing");
  t.mock.timers.tick(1500);
  await Promise.resolve();
  assert.equal(ctx.closed, false, "the audio context stays open while speech is queued");
  t.mock.timers.tick(600);
  await Promise.resolve();
  assert.equal(ctx.closed, true);
});

test("toggling off stops at once, dropping queued speech", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { v, ws, ctx } = await live();
  ws.audio(48000);
  await v.toggle();
  assert.deepEqual([v.state.value, v.live.value], ["idle", false]);
  assert.equal(ctx.sources[0]!.stopped, true);
  t.mock.timers.tick(0);
  await Promise.resolve();
  assert.equal(ctx.closed, true);
  assert.equal(ws.onclose, null, "a socket we closed ourselves doesn't call stop again");
});
