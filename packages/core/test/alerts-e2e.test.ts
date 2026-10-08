/**
 * A timer from creation to answer, over real sockets: the service rings a device's control connection, the device
 * opens /ws/audio?alert=, the session plays the tone before Gemini's audio, and the user's words acknowledge it.
 * Gemini is a fake Live connection; time is real but short.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import WebSocket from "ws";
import { ToolRegistry } from "@friday/sdk";
import type { LiveServerMessage } from "@google/genai";
import { migrate, migrations } from "../src/storage/db.js";
import { AlertStore } from "../src/alerts/store.js";
import { AlertService } from "../src/alerts/service.js";
import { DeviceLinks } from "../src/devices/links.js";
import { attachAudioWs } from "../src/transports/ws.js";
import { attachDeviceWs } from "../src/transports/device-ws.js";
import { GeminiSession, type LiveConnect } from "../src/session.js";
import { settings } from "../src/config.js";
import { deviceFixture, waitFor } from "./helpers.js";

const quiet = { log() {}, error() {} };

async function world() {
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...a) => logs.push(a.map(String).join(" "));
  const devices = deviceFixture();
  const key = devices.register("friday-kitchen");
  const db = new DatabaseSync(":memory:");
  migrate(db, migrations, quiet);
  const links = new DeviceLinks();
  const alerts = new AlertService({
    store: new AlertStore(db),
    links,
    sessions: devices.sessions,
    timezone: () => "Europe/Amsterdam",
    rings: 3,
    ringIntervalMs: 200,
    graceMs: 60_000,
    log: quiet,
  });
  // Gemini: remembers what it was sent; the test plays its side through session.handle().
  const sessions: GeminiSession[] = [];
  const openings: string[] = [];
  const connect: LiveConnect = async () => ({
    sendRealtimeInput() {},
    sendClientContent: (c) => void openings.push(JSON.stringify(c)),
    sendToolResponse() {},
    close() {},
  });
  const registry = new ToolRegistry(quiet);
  const server = createServer();
  attachAudioWs(server, {
    pingMs: 0,
    devices: devices.store,
    deviceSessions: devices.sessions,
    alerts,
    createSession: (onEvent, recorder, device, alert) => {
      const s = new GeminiSession(onEvent, registry, { connect, log: quiet, recorder, device: device?.id, ...alert });
      sessions.push(s);
      return s;
    },
  });
  attachDeviceWs(server, { pingMs: 0, devices: devices.store, links, onReport: (id, type, alert) => alerts.deviceReport(id, type, alert) });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `ws://127.0.0.1:${(server.address() as { port: number }).port}`;
  const auth = { headers: { authorization: `Bearer ${key}` } };
  alerts.start();

  /** The device: a control connection that answers every ring with an alert session, collecting what it hears. */
  const heard: Buffer[][] = [];
  const sockets: WebSocket[] = [];
  const control = new WebSocket(`${base}/ws/device?device=friday-kitchen`, auth);
  sockets.push(control);
  await once(control, "open");
  await waitFor(() => links.online("friday-kitchen"));
  control.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type !== "ring") return;
    const frames: Buffer[] = [];
    heard.push(frames);
    const audio = new WebSocket(`${base}/ws/audio?device=friday-kitchen&alert=${msg.data.alert}`, auth);
    sockets.push(audio);
    audio.on("error", () => {}); // terminated at the end of a test, maybe while still connecting
    audio.on("message", (data, isBinary) => void (isBinary && frames.push(data as Buffer)));
  });

  const close = async () => {
    alerts.stop();
    for (const s of sessions) s.close();
    for (const ws of sockets) ws.terminate();
    server.closeAllConnections();
    server.close();
    console.log = origLog;
  };
  return { alerts, sessions, openings, heard, logs, close };
}

const msg = (serverContent: LiveServerMessage["serverContent"]) => ({ serverContent }) as LiveServerMessage;

test("a timer rings, the device hears the tone and then Friday, and the user's answer acknowledges it", async () => {
  const w = await world();
  try {
    const a = w.alerts.create({ kind: "timer", label: "eggs", language: "nl", dueAt: new Date(Date.now() + 100), target: { kind: "device", id: "friday-kitchen" } });
    await waitFor(() => w.sessions.length === 1 && w.openings.length === 1);
    assert.match(w.openings[0], /Alert: the timer \\"eggs\\".*in Dutch/);
    const s = w.sessions[0];
    s.handle(msg({ modelTurn: { parts: [{ inlineData: { data: Buffer.from([9, 9]).toString("base64"), mimeType: "audio/pcm" } }] }, outputTranscription: { text: "Je eieren zijn klaar." } }));
    s.handle(msg({ turnComplete: true }));
    await waitFor(() => Buffer.concat(w.heard[0]).subarray(-2).equals(Buffer.from([9, 9])));
    const all = Buffer.concat(w.heard[0]);
    assert.ok(all.length > 2 * 24_000, "the tone came first");
    s.handle(msg({ inputTranscription: { text: "Dank je" } }));
    assert.equal(w.alerts.get(a.id)!.state, "acknowledged");
  } finally {
    await w.close();
  }
});

test("without an answer the alert session closes with no answer and the timer rings again", async () => {
  const w = await world();
  const previous = settings.idleTimeoutMs;
  settings.idleTimeoutMs = 50;
  try {
    const a = w.alerts.create({ kind: "timer", label: "eggs", language: "en", dueAt: new Date(Date.now() + 50), target: { kind: "device", id: "friday-kitchen" } });
    await waitFor(() => w.sessions.length === 1);
    w.sessions[0].handle(msg({ outputTranscription: { text: "Your eggs timer is done." }, turnComplete: true }));
    await waitFor(() => w.alerts.get(a.id)!.rings === 1);
    assert.equal(w.alerts.get(a.id)!.state, "ringing");
    await waitFor(() => w.sessions.length === 2, 3000);
    assert.equal(w.heard.length, 2, "the device was rung a second time");
  } finally {
    settings.idleTimeoutMs = previous;
    await w.close();
  }
});
