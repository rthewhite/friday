import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { ToolRegistry } from "@friday/sdk";
import { migrate, migrations } from "../src/storage/db.js";
import { AlertStore } from "../src/alerts/store.js";
import { AlertService } from "../src/alerts/service.js";
import { registerAlertTools, MAX_TIMERS_PER_DEVICE } from "../src/alerts/tools.js";
import { DeviceLinks } from "../src/devices/links.js";
import { DeviceSessions } from "../src/devices/sessions.js";
import { FakeClock } from "./fake-clock.js";

const quiet = { log() {}, error() {} };
const KITCHEN = "friday-kitchen";
const MIN = 60_000;

function setup() {
  const db = new DatabaseSync(":memory:");
  migrate(db, migrations, quiet);
  const clock = new FakeClock(Date.parse("2026-10-08T10:00:00Z")); // 12:00 in Amsterdam
  const store = new AlertStore(db, { now: () => new Date(clock.now()) });
  const links = new DeviceLinks();
  const sent: { type: string; data: { alert: string } }[] = [];
  links.add(KITCHEN, { send: (d) => void sent.push(JSON.parse(d)), close() {} });
  links.add("friday-hall", { send() {}, close() {} });
  const alerts = new AlertService({ store, links, sessions: new DeviceSessions(), clock, log: quiet, timezone: () => "Europe/Amsterdam", rings: 5, ringIntervalMs: MIN, graceMs: 10 * MIN });
  alerts.start();
  const registry = new ToolRegistry(quiet);
  const labels: Record<string, string> = { [KITCHEN]: "Kitchen satellite", "friday-hall": "Hall" };
  registerAlertTools(registry, { alerts, links, deviceLabel: (id) => labels[id] ?? id, timezone: () => "Europe/Amsterdam", now: clock.now });
  /** Call a tool as a voice session of `device` would; null for a session without a device (the Talk page). */
  const call = async (name: string, args: Record<string, unknown>, device: string | null = KITCHEN) =>
    (await registry.callTool(name, args, { channel: "voice", device: device ?? undefined, conversationId: "c1" })).result as Record<string, any>;
  return { clock, store, alerts, registry, links, sent, call };
}

test("the four timer tools are voice-only and owned by core", () => {
  const { registry } = setup();
  assert.deepEqual(registry.list().filter((t) => t.owner === "core").map((t) => t.name), ["set_timer", "list_timers", "cancel_timer", "snooze_alert"]);
  assert.deepEqual(registry.declarations("chat").map((d) => d.name), []);
});

test("kitchen timer: set_timer returns at once with the due time, and the timer rings this device", async () => {
  const t = setup();
  const r = await t.call("set_timer", { seconds: 300, label: "eggs", language: "nl" });
  assert.deepEqual({ ...r, id: undefined }, { id: undefined, label: "eggs", due: "12:05:00", seconds: 300 });
  const stored = t.store.get(r.id)!;
  assert.deepEqual({ target: stored.target, language: stored.language, conversationId: stored.conversationId, state: stored.state }, { target: { kind: "device", id: KITCHEN }, language: "nl", conversationId: "c1", state: "scheduled" });
  await t.clock.advance(5 * MIN);
  assert.deepEqual(t.sent.map((m) => m.type), ["ring"]);
});

test("a blank or missing label is 'timer'; bad seconds, label and language are refused", async () => {
  const t = setup();
  assert.equal((await t.call("set_timer", { seconds: 60, label: "  ", language: "en" })).label, "timer");
  assert.equal((await t.call("set_timer", { seconds: 60, language: "en" })).label, "timer");
  for (const seconds of [0, 86_401, 1.5, "60"]) assert.match((await t.call("set_timer", { seconds, language: "en" })).error, /seconds must be/);
  assert.match((await t.call("set_timer", { seconds: 60, label: "x".repeat(61), language: "en" })).error, /at most 60/);
  assert.match((await t.call("set_timer", { seconds: 60, language: "de" })).error, /nl or en/);
  assert.equal(t.store.active().length, 2);
});

test("no device: set_timer on the Talk page explains timers need a voice device and sets nothing", async () => {
  const t = setup();
  const r = await t.call("set_timer", { seconds: 300, language: "en" }, null);
  assert.match(r.error, /only be set on a voice device/);
  assert.equal(t.store.active().length, 0);
});

test("old firmware: a device without a control connection can't have a timer", async () => {
  const t = setup();
  const r = await t.call("set_timer", { seconds: 300, language: "en" }, "friday-old");
  assert.match(r.error, /can't ring.*firmware/);
  assert.equal(t.store.active().length, 0);
});

test("a device has at most 20 scheduled timers", async () => {
  const t = setup();
  for (let i = 0; i < MAX_TIMERS_PER_DEVICE; i++) assert.ok((await t.call("set_timer", { seconds: 600 + i, language: "en" })).id);
  assert.match((await t.call("set_timer", { seconds: 60, language: "en" })).error, /already has 20 timers/);
  assert.ok((await t.call("set_timer", { seconds: 60, language: "en" }, "friday-hall")).id, "other devices are unaffected");
});

test("list_timers: every device's timers with seconds left, and an empty list when none run", async () => {
  const t = setup();
  assert.deepEqual(await t.call("list_timers", {}), { timers: [] });
  const eggs = await t.call("set_timer", { seconds: 300, label: "eggs", language: "en" });
  const tea = await t.call("set_timer", { seconds: 600, label: "tea", language: "en" }, "friday-hall");
  await t.clock.advance(210_000);
  assert.deepEqual((await t.call("list_timers", {})).timers, [
    { id: eggs.id, label: "eggs", device: "Kitchen satellite", due: "12:05:00", seconds_left: 90, state: "scheduled" },
    { id: tea.id, label: "tea", device: "Hall", due: "12:10:00", seconds_left: 390, state: "scheduled" },
  ]);
});

test("cancel_timer by label: only that timer is cancelled", async () => {
  const t = setup();
  const eggs = await t.call("set_timer", { seconds: 300, label: "eggs", language: "en" });
  const pasta = await t.call("set_timer", { seconds: 600, label: "Pasta", language: "en" });
  assert.deepEqual(await t.call("cancel_timer", { label: "pasta" }), { cancelled: { id: pasta.id, label: "Pasta" } });
  assert.equal(t.store.get(pasta.id)!.state, "cancelled");
  assert.equal(t.store.get(eggs.id)!.state, "scheduled");
});

test("cancel_timer by id, and the only timer without arguments", async () => {
  const t = setup();
  const a = await t.call("set_timer", { seconds: 300, language: "en" });
  const b = await t.call("set_timer", { seconds: 600, language: "en" });
  assert.deepEqual((await t.call("cancel_timer", { id: b.id.toUpperCase() })).cancelled, { id: b.id, label: "timer" });
  assert.deepEqual((await t.call("cancel_timer", {})).cancelled, { id: a.id, label: "timer" });
});

test("cancel_timer: ambiguous or unknown cancels nothing and lists the running timers", async () => {
  const t = setup();
  assert.match((await t.call("cancel_timer", {})).error, /No timer is running/);
  const a = await t.call("set_timer", { seconds: 300, language: "en" });
  const b = await t.call("set_timer", { seconds: 600, language: "en" });
  const ambiguous = await t.call("cancel_timer", { label: "timer" });
  assert.match(ambiguous.error, /Several timers match/);
  assert.deepEqual(ambiguous.timers.map((x: { id: string; due: string }) => [x.id, x.due]), [[a.id, "12:05:00"], [b.id, "12:10:00"]]);
  assert.match((await t.call("cancel_timer", { label: "rice" })).error, /No timer matches/);
  assert.equal(t.store.active().length, 2);
});

test("cancel_timer stops a ringing timer", async () => {
  const t = setup();
  const a = await t.call("set_timer", { seconds: 60, label: "eggs", language: "en" });
  await t.clock.advance(MIN);
  assert.equal(t.store.get(a.id)!.state, "ringing");
  await t.call("cancel_timer", { label: "eggs" });
  assert.deepEqual(t.sent.map((m) => m.type), ["ring", "stop"]);
});

test("snooze_alert in the alert session rings again after the minutes given, default 5", async () => {
  const t = setup();
  const a = await t.call("set_timer", { seconds: 60, label: "eggs", language: "en" });
  await t.clock.advance(MIN);
  const claim = t.alerts.claim(KITCHEN, a.id)!;
  claim.acknowledge();
  assert.deepEqual(await t.call("snooze_alert", {}), { snoozed: ["eggs"], due: "12:06:00" });
  claim.closed();
  assert.equal(t.store.get(a.id)!.state, "scheduled");
  await t.clock.advance(5 * MIN);
  assert.equal(t.sent.filter((m) => m.type === "ring").length, 2);
});

test("snooze_alert outside an alert session, or with bad minutes, changes nothing", async () => {
  const t = setup();
  const a = await t.call("set_timer", { seconds: 300, label: "eggs", language: "en" });
  assert.match((await t.call("snooze_alert", { minutes: 5 })).error, /Nothing is ringing/);
  assert.match((await t.call("snooze_alert", { minutes: 0 })).error, /1 to 60/);
  assert.match((await t.call("snooze_alert", { minutes: 61 })).error, /1 to 60/);
  assert.equal(t.store.get(a.id)!.dueAt, "2026-10-08T10:05:00.000Z");
});
