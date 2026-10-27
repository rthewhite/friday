/**
 * Core's side of the device protocol contract in fixtures/device-protocol.json. The firmware's host test
 * (esphome/test/friday_protocol_test.cpp) checks the same file, so a change on one side only fails the other.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import WebSocket from "ws";
import { migrate, migrations } from "../src/storage/db.js";
import { AlertStore } from "../src/alerts/store.js";
import { AlertService } from "../src/alerts/service.js";
import { DeviceLinks } from "../src/devices/links.js";
import { DeviceSessions } from "../src/devices/sessions.js";
import { DEVICE_ID, fingerprint } from "../src/devices/store.js";
import { hashKey } from "../src/remote/key-store.js";
import { attachDeviceWs, type DeviceReport } from "../src/transports/device-ws.js";
import { deviceFixture, startHarness, StubSession, waitFor } from "./helpers.js";
import { FakeClock } from "./fake-clock.js";

type Flat = Record<string, string | boolean>;
interface Fixture {
  about: string;
  serverMessages: Flat[];
  deviceMessages: Flat[];
  uris: Flat[];
  deviceIds: Flat[];
  alertIds: Flat[];
  fingerprints: Flat[];
}

const fixture = JSON.parse(readFileSync(new URL("./fixtures/device-protocol.json", import.meta.url), "utf8")) as Fixture;
const str = (v: string | boolean | undefined) => String(v ?? "");
const quiet = { log() {}, error() {} };
const MIN = 60_000;
/** The firmware's rule for alert ids (valid_alert_id in friday_protocol.h). */
const FIRMWARE_ALERT_ID = /^[a-z0-9]{1,16}$/;

test("the fixture stays flat enough for the firmware's reader", () => {
  for (const [section, value] of Object.entries(fixture)) {
    if (section === "about") continue;
    assert.ok(Array.isArray(value) && value.length > 0, `${section} is a non-empty array`);
    for (const entry of value as unknown[]) {
      assert.equal(typeof entry, "object", section);
      for (const [k, v] of Object.entries(entry as object)) assert.ok(typeof v === "string" || typeof v === "boolean", `${section}.${k} is a string or boolean`);
    }
  }
});

test("core sends a device exactly the listed /ws/audio messages, and never the browser's", async () => {
  const devices = deviceFixture();
  const key = devices.register("friday-kitchen");
  const h = await startHarness({ devices: devices.store });
  try {
    const ws = await h.connect("?device=friday-kitchen", key);
    const received: string[] = [];
    ws.on("message", (raw, binary) => void (binary || received.push(raw.toString())));
    await waitFor(() => StubSession.instances.length === 1);
    const session = StubSession.instances[0]!;
    const audio = fixture.serverMessages.filter((m) => m.channel === "audio");
    for (const m of audio) session.emit({ kind: str(m.type), ...(m.data !== undefined && { data: str(m.data) }) } as Parameters<StubSession["emit"]>[0]);
    const sent = audio.filter((m) => !m.browserOnly);
    await waitFor(() => received.length >= sent.length);
    assert.deepEqual(received, sent.map((m) => m.raw));
  } finally {
    await h.close();
  }
});

test("core rings and stops a device with exactly the listed /ws/device messages", async () => {
  const db = new DatabaseSync(":memory:");
  migrate(db, migrations, quiet);
  const clock = new FakeClock(Date.parse("2026-10-08T10:00:00Z"));
  const store = new AlertStore(db, { now: () => new Date(clock.now()) });
  const links = new DeviceLinks();
  const service = new AlertService({ store, links, sessions: new DeviceSessions(), clock, log: quiet, timezone: () => "Europe/Amsterdam", rings: 5, ringIntervalMs: MIN, graceMs: 10 * MIN, alarmWindowMs: 30 * MIN });
  const sent: string[] = [];
  links.add("friday-kitchen", { send: (d: string) => void sent.push(d), close() {} });
  service.start();
  try {
    const a = service.create({ kind: "timer", label: "eggs", language: "en", dueAt: new Date(clock.now() + 5 * MIN), target: { kind: "device", id: "friday-kitchen" } });
    await clock.advance(5 * MIN);
    const claim = service.claim("friday-kitchen", a.id)!;
    claim.acknowledge();
    claim.closed();
    // Alert ids are random; the fixture's stands in for this one.
    const control = fixture.serverMessages.filter((m) => m.channel === "control" && !m.neverSent);
    assert.deepEqual(sent.map((raw) => raw.replaceAll(`"${a.id}"`, `"${str(control[0]!.alert)}"`)), control.map((m) => m.raw));
  } finally {
    service.stop();
  }
});

test("core reads the listed device messages on /ws/device", async () => {
  const devices = deviceFixture();
  const key = devices.register("friday-kitchen");
  const reports: [string, DeviceReport, string][] = [];
  const server = createServer();
  const wss = attachDeviceWs(server, { pingMs: 0, devices: devices.store, links: new DeviceLinks(), onReport: (id, type, alert) => reports.push([id, type, alert]) });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${(server.address() as { port: number }).port}/ws/device?device=friday-kitchen`, { headers: { authorization: `Bearer ${key}` } });
    await once(ws, "open");
    for (const m of fixture.deviceMessages) ws.send(str(m.raw));
    await waitFor(() => reports.length === fixture.deviceMessages.length);
    assert.deepEqual(reports, fixture.deviceMessages.map((m) => ["friday-kitchen", m.type, m.alert]));
  } finally {
    for (const c of wss.clients) c.terminate();
    wss.close();
    server.close();
  }
});

test("core reads the device and alert from the URIs a device builds", async () => {
  const devices = deviceFixture();
  const keys = new Map([...new Set(fixture.uris.map((u) => str(u.device)))].map((id) => [id, devices.register(id)]));
  const claims: [string, string][] = [];
  const audio = await startHarness({ devices: devices.store, alerts: { claim: (device: string, alert: string) => void claims.push([device, alert]) } });
  const linkSet = new DeviceLinks();
  const server = createServer();
  const control = attachDeviceWs(server, { pingMs: 0, devices: devices.store, links: linkSet });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const controlBase = `ws://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    for (const u of fixture.uris) {
      const device = str(u.device), key = keys.get(device)!;
      const uri = new URL(str(u.audio));
      if (uri.pathname === "/ws/audio") {
        const local = new URL(uri.pathname + uri.search, audio.url);
        if (u.alert) {
          const ws = new WebSocket(local, { headers: { authorization: `Bearer ${key}` } });
          const [code] = (await once(ws, "close")) as [number];
          assert.equal(code, 4410, "an alert that isn't ringing is gone");
          assert.deepEqual(claims.at(-1), [device, u.alert], str(u.audio));
        } else {
          const before = StubSession.instances.length;
          const ws = new WebSocket(local, { headers: { authorization: `Bearer ${key}` } });
          await once(ws, "open");
          await waitFor(() => StubSession.instances.length === before + 1);
          assert.equal(StubSession.instances.at(-1)!.device?.id, device, str(u.audio));
          ws.close();
        }
      }
      if (u.control) {
        const c = new URL(str(u.control));
        assert.equal(c.pathname, "/ws/device");
        const ws = new WebSocket(controlBase + c.pathname + c.search, { headers: { authorization: `Bearer ${key}` } });
        await once(ws, "open");
        await waitFor(() => linkSet.online(device));
        ws.close();
        await waitFor(() => !linkSet.online(device));
      }
    }
  } finally {
    for (const c of control.clients) c.terminate();
    control.close();
    server.close();
    await audio.close();
  }
});

test("core and the firmware's config validation accept exactly the listed device ids", () => {
  for (const d of fixture.deviceIds) assert.equal(DEVICE_ID.test(str(d.id)), d.valid, JSON.stringify(d.id));
  // The firmware checks device ids when the YAML is validated (esphome config), with the same pattern.
  const init = readFileSync(new URL("../../../esphome/components/friday_client/__init__.py", import.meta.url), "utf8");
  const python = /DEVICE_ID = re\.compile\(r"([^"]+)"\)/.exec(init)?.[1];
  assert.equal(python, DEVICE_ID.source);
});

test("the alert ids core generates are ones the firmware accepts, and the fixture follows that rule", () => {
  const db = new DatabaseSync(":memory:");
  migrate(db, migrations, quiet);
  const store = new AlertStore(db);
  for (let i = 0; i < 50; i++) {
    const a = store.create({ kind: "timer", label: "x", language: "en", dueAt: new Date(Date.now() + MIN), target: { kind: "device", id: "friday-kitchen" } });
    assert.match(a.id, FIRMWARE_ALERT_ID);
  }
  for (const a of fixture.alertIds) assert.equal(FIRMWARE_ALERT_ID.test(str(a.id)), a.valid, JSON.stringify(a.id));
  const ringed = fixture.serverMessages.filter((m) => m.channel === "control" && !m.neverSent).map((m) => str(m.alert));
  assert.ok(ringed.every((id) => FIRMWARE_ALERT_ID.test(id)), "the messages core sends carry valid alert ids");
});

test("core's key fingerprints match the listed vectors", () => {
  for (const f of fixture.fingerprints) {
    assert.equal(hashKey(str(f.key)), f.sha256);
    assert.equal(fingerprint(hashKey(str(f.key))), f.fingerprint);
  }
});
