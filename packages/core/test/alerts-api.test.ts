import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { ToolRegistry } from "@friday/sdk";
import { createApp } from "../src/app.js";
import { ModuleHost } from "../src/module-host.js";
import { McpSource } from "../src/tools/mcp.js";
import { AlertStore, type NewAlert } from "../src/alerts/store.js";
import { AlertService } from "../src/alerts/service.js";
import { DeviceLinks } from "../src/devices/links.js";
import { deviceFixture } from "./helpers.js";
import { FakeClock } from "./fake-clock.js";

const quiet = { log() {}, warn() {}, error() {} };
const MIN = 60_000;

async function start(opts: { withAlerts?: boolean } = {}) {
  const fixture = deviceFixture();
  fixture.register("friday-kitchen", { label: "Kitchen satellite" });
  fixture.register("friday-hall", { label: "Hall" });
  const clock = new FakeClock(Date.parse("2026-10-08T10:00:00Z"));
  const store = new AlertStore(fixture.db, { now: () => new Date(clock.now()) });
  const links = new DeviceLinks();
  const sent: string[] = [];
  links.add("friday-kitchen", { send: (d) => void sent.push(d), close() {} });
  const alerts = new AlertService({ store, links, sessions: fixture.sessions, clock, log: quiet, timezone: () => "Europe/Amsterdam", rings: 5, ringIntervalMs: MIN, graceMs: 10 * MIN });
  alerts.start();
  const registry = new ToolRegistry(quiet);
  const server = createServer(
    createApp({
      registry,
      host: new ModuleHost(registry, { env: {}, log: quiet }),
      mcp: new McpSource(registry, undefined, { log: quiet }),
      webDir: "/nonexistent",
      devices: fixture.store,
      deviceSessions: fixture.sessions,
      deviceLinks: links,
      ...(opts.withAlerts ?? true ? { alerts } : {}),
    }),
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const call = async (method: string, path: string) => {
    const res = await fetch(base + path, { method });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : undefined };
  };
  const timer = (over: Partial<NewAlert> = {}) =>
    alerts.create({ kind: "timer", label: "eggs", language: "en", dueAt: new Date(clock.now() + 5 * MIN), target: { kind: "device", id: "friday-kitchen" }, ...over });
  const close = async () => {
    alerts.stop();
    server.closeAllConnections();
    server.close();
    await once(server, "close");
  };
  return { fixture, clock, store, alerts, sent, call, timer, close };
}

test("listing: active alerts by due time first, then finished ones newest first, with device labels", async () => {
  const s = await start();
  try {
    const pasta = s.timer({ label: "pasta", dueAt: new Date(s.clock.now() + 10 * MIN) });
    const eggs = s.timer();
    const tea = s.timer({ label: "tea", target: { kind: "device", id: "friday-hall" } });
    await s.clock.advance(MIN);
    s.alerts.cancel(tea.id);
    await s.clock.advance(15 * MIN); // eggs rang, nobody answered: missed; pasta too
    const missed = s.timer({ label: "rice", dueAt: new Date(s.clock.now() + MIN) });
    const { status, body } = await s.call("GET", "/api/alerts");
    assert.equal(status, 200);
    assert.deepEqual(body.alerts.map((a: { label: string; state: string }) => [a.label, a.state]), [
      ["rice", "scheduled"],
      ["pasta", "missed"],
      ["eggs", "missed"],
      ["tea", "cancelled"],
    ]);
    const first = body.alerts[0];
    assert.deepEqual(Object.keys(first).sort(), ["createdAt", "dueAt", "finishedAt", "id", "kind", "label", "rings", "state", "target"]);
    assert.deepEqual(first.target, { kind: "device", id: "friday-kitchen", label: "Kitchen satellite" });
    assert.equal(first.id, missed.id);
    assert.equal(body.alerts.find((a: { id: string }) => a.id === pasta.id).rings, 5);
    assert.equal(body.alerts.find((a: { id: string }) => a.id === eggs.id).finishedAt !== null, true);
  } finally {
    await s.close();
  }
});

test("a deleted device's alerts are cancelled and listed without a device label", async () => {
  const s = await start();
  try {
    const a = s.timer({ target: { kind: "device", id: "friday-hall" } });
    assert.equal((await s.call("DELETE", "/api/devices/friday-hall")).status, 204);
    const listed = (await s.call("GET", "/api/alerts")).body.alerts.find((x: { id: string }) => x.id === a.id);
    assert.equal(listed.state, "cancelled");
    assert.deepEqual(listed.target, { kind: "device", id: "friday-hall" });
  } finally {
    await s.close();
  }
});

test("DELETE cancels a scheduled timer with 204; unknown is 404 and finished is 409", async () => {
  const s = await start();
  try {
    const a = s.timer();
    assert.equal((await s.call("DELETE", `/api/alerts/${a.id}`)).status, 204);
    assert.equal(s.store.get(a.id)!.state, "cancelled");
    await s.clock.advance(10 * MIN);
    assert.deepEqual(s.sent, [], "a cancelled timer doesn't ring");
    const again = await s.call("DELETE", `/api/alerts/${a.id}`);
    assert.equal(again.status, 409);
    assert.match(again.body.error, /already cancelled/);
    assert.equal((await s.call("DELETE", "/api/alerts/nope")).status, 404);
  } finally {
    await s.close();
  }
});

test("without an alert service the alerts API answers 503", async () => {
  const s = await start({ withAlerts: false });
  try {
    assert.equal((await s.call("GET", "/api/alerts")).status, 503);
    assert.equal((await s.call("DELETE", "/api/alerts/abcd")).status, 503);
  } finally {
    await s.close();
  }
});
