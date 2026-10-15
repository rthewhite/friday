import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { ToolRegistry } from "@friday/sdk";
import { migrate, migrations } from "../src/storage/db.js";
import { AlertStore } from "../src/alerts/store.js";
import { AlertService } from "../src/alerts/service.js";
import { registerAlertTools, MAX_ALARMS_PER_DEVICE, MAX_TIMERS_PER_DEVICE } from "../src/alerts/tools.js";
import { DeviceLinks } from "../src/devices/links.js";
import { DeviceSessions } from "../src/devices/sessions.js";
import { FakeClock } from "./fake-clock.js";

const quiet = { log() {}, error() {} };
const KITCHEN = "friday-kitchen";
const MIN = 60_000;
/** Tuesday 13 October 2026, 23:41 in Amsterdam: the night the alarm didn't go off. */
const NIGHT = "2026-10-13T21:41:13Z";

function setup(start = "2026-10-08T10:00:00Z" /* Thursday, 12:00 in Amsterdam */) {
  const db = new DatabaseSync(":memory:");
  migrate(db, migrations, quiet);
  const clock = new FakeClock(Date.parse(start));
  const store = new AlertStore(db, { now: () => new Date(clock.now()) });
  const links = new DeviceLinks();
  const sent: { type: string; data: { alert: string } }[] = [];
  links.add(KITCHEN, { send: (d) => void sent.push(JSON.parse(d)), close() {} });
  links.add("friday-hall", { send() {}, close() {} });
  const alerts = new AlertService({
    store, links, sessions: new DeviceSessions(), clock, log: quiet, timezone: () => "Europe/Amsterdam",
    rings: 5, ringIntervalMs: MIN, graceMs: 10 * MIN, alarmWindowMs: 30 * MIN,
  });
  alerts.start();
  const registry = new ToolRegistry(quiet);
  const labels: Record<string, string> = { [KITCHEN]: "Kitchen satellite", "friday-hall": "Hall" };
  registerAlertTools(registry, { alerts, links, deviceLabels: () => new Map(Object.entries(labels)), timezone: () => "Europe/Amsterdam", now: clock.now });
  /** Call a tool as a voice session of `device` would; null for a session without a device (the Talk page). */
  const call = async (name: string, args: Record<string, unknown>, device: string | null = KITCHEN) =>
    (await registry.callTool(name, args, { channel: "voice", device: device ?? undefined, conversationId: "c1" })).result as Record<string, any>;
  const rings = () => sent.filter((m) => m.type === "ring").length;
  return { clock, store, alerts, registry, links, sent, call, rings };
}

test("the six alert tools are voice-only and owned by core", () => {
  const { registry } = setup();
  assert.deepEqual(
    registry.list().filter((t) => t.owner === "core").map((t) => t.name),
    ["set_timer", "set_alarm", "list_alerts", "change_alert", "cancel_alert", "snooze_alert"],
  );
  assert.deepEqual(registry.declarations("chat").map((d) => d.name), []);
});

test("the descriptions steer: timers for a length, alarms for a time of day, change instead of a second, say `when`", () => {
  const { registry } = setup();
  const d = Object.fromEntries(registry.declarations("voice").map((x) => [x.name, x.description ?? ""]));
  assert.match(d.set_timer, /time of day .* set_alarm/);
  assert.match(d.set_alarm, /change_alert, never set another/);
  assert.match(d.list_alerts, /before telling the user/);
  assert.match(d.change_alert, /never set a second/);
  for (const name of ["set_timer", "set_alarm", "list_alerts", "change_alert", "cancel_alert"]) assert.match(d[name], /say its `when`/, name);
});

// set_timer

test("kitchen timer: set_timer returns at once with the due time and `when`, and the timer rings this device", async () => {
  const t = setup();
  const r = await t.call("set_timer", { seconds: 300, label: "eggs", language: "en" });
  assert.deepEqual({ ...r, id: undefined }, { id: undefined, kind: "timer", label: "eggs", due: "12:05", when: "today at 12:05", seconds: 300 });
  const stored = t.store.get(r.id)!;
  assert.deepEqual(
    { kind: stored.kind, target: stored.target, language: stored.language, conversationId: stored.conversationId, state: stored.state },
    { kind: "timer", target: { kind: "device", id: KITCHEN }, language: "en", conversationId: "c1", state: "scheduled" },
  );
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

test("no device: set_timer and set_alarm on the Talk page explain they need a voice device and set nothing", async () => {
  const t = setup();
  assert.match((await t.call("set_timer", { seconds: 300, language: "en" }, null)).error, /Timers can only be set on a voice device/);
  assert.match((await t.call("set_alarm", { time: "07:30", language: "en" }, null)).error, /Alarms can only be set on a voice device/);
  assert.equal(t.store.active().length, 0);
});

test("old firmware: a device without a control connection can't have a timer or an alarm", async () => {
  const t = setup();
  assert.match((await t.call("set_timer", { seconds: 300, language: "en" }, "friday-old")).error, /can't ring.*firmware.*No timer/);
  assert.match((await t.call("set_alarm", { time: "07:30", language: "en" }, "friday-old")).error, /can't ring.*firmware.*No alarm/);
  assert.equal(t.store.active().length, 0);
});

test("a device has at most 20 scheduled timers and 20 scheduled alarms", async () => {
  const t = setup();
  for (let i = 0; i < MAX_TIMERS_PER_DEVICE; i++) assert.ok((await t.call("set_timer", { seconds: 600 + i, language: "en" })).id);
  assert.match((await t.call("set_timer", { seconds: 60, language: "en" })).error, /already has 20 timers/);
  assert.ok((await t.call("set_timer", { seconds: 60, language: "en" }, "friday-hall")).id, "other devices are unaffected");
  for (let i = 0; i < MAX_ALARMS_PER_DEVICE; i++) assert.ok((await t.call("set_alarm", { time: `13:${String(i).padStart(2, "0")}`, language: "en" })).id);
  assert.match((await t.call("set_alarm", { time: "14:00", language: "en" })).error, /already has 20 alarms/);
});

// set_alarm

test("13 October: 'maak me morgen om half acht wakker' at 23:41 is an alarm at 07:30 local, said back as morgen om 07:30", async () => {
  const t = setup(NIGHT);
  const r = await t.call("set_alarm", { time: "07:30", label: "wekker", language: "nl" });
  assert.deepEqual(
    { ...r, id: undefined },
    { id: undefined, kind: "alarm", label: "wekker", due: "07:30", when: "morgen, woensdag 14 oktober, om 07:30", in: "7 hours 48 minutes 47 seconds", others: [] },
  );
  const stored = t.store.get(r.id)!;
  assert.deepEqual({ kind: stored.kind, dueAt: stored.dueAt, state: stored.state }, { kind: "alarm", dueAt: "2026-10-14T05:30:00.000Z", state: "scheduled" });
  await t.clock.to("2026-10-14T05:29:59Z");
  assert.equal(t.rings(), 0);
  await t.clock.to("2026-10-14T05:30:00Z");
  assert.equal(t.rings(), 1);
});

test("set_alarm: a blank label is 'alarm', a given date is that day, and bad times, dates and DST gaps set nothing", async () => {
  const t = setup(NIGHT);
  assert.equal((await t.call("set_alarm", { time: "06:45", label: " ", language: "en" })).label, "alarm");
  const friday = await t.call("set_alarm", { time: "06:45", date: "2026-10-16", language: "en" });
  assert.equal(friday.when, "Friday 16 October at 06:45");
  assert.equal(t.store.get(friday.id)!.dueAt, "2026-10-16T04:45:00.000Z");
  assert.match((await t.call("set_alarm", { time: "7:30", language: "en" })).error, /HH:MM.*No alarm was set/);
  assert.match((await t.call("set_alarm", { time: "07:30", date: "2026-10-21", language: "en" })).error, /at most 7 days/);
  assert.match((await t.call("set_alarm", { time: "07:30", date: "2026-10-12", language: "en" })).error, /in the past/);
  assert.match((await t.call("set_alarm", { time: "07:30", language: "fr" })).error, /nl or en/);
  assert.match((await t.call("set_alarm", { time: "07:30", label: "x".repeat(61), language: "en" })).error, /at most 60/);
  assert.equal(t.store.active().length, 2);
  const spring = setup("2026-03-28T12:00:00Z");
  assert.match((await spring.call("set_alarm", { time: "02:30", date: "2026-03-29", language: "en" })).error, /does not occur/);
  assert.equal(spring.store.active().length, 0);
});

test("set_alarm lists the device's other alarms, so the model can ask about the 08:30 one", async () => {
  const t = setup(NIGHT);
  const first = await t.call("set_alarm", { time: "08:30", language: "nl" });
  await t.call("set_alarm", { time: "09:00", language: "nl" }, "friday-hall");
  await t.call("set_timer", { seconds: 600, language: "nl" });
  const second = await t.call("set_alarm", { time: "07:30", label: "wekker", language: "nl" });
  assert.deepEqual(second.others, [{ id: first.id, kind: "alarm", label: "alarm", due: "08:30", when: "morgen, woensdag 14 oktober, om 08:30" }]);
});

test("setting the same alarm twice returns the one already set", async () => {
  const t = setup(NIGHT);
  const first = await t.call("set_alarm", { time: "07:30", label: "wekker", language: "nl" });
  const again = await t.call("set_alarm", { time: "07:30", language: "nl" });
  assert.equal(again.id, first.id);
  assert.equal(again.already_set, true);
  assert.equal(t.store.active().length, 1);
  assert.ok((await t.call("set_alarm", { time: "07:30", language: "nl" }, "friday-hall")).id !== first.id, "another device gets its own");
});

// list_alerts

test("list_alerts: timers and alarms of every device, by due time, with `when` and seconds left; empty when none", async () => {
  const t = setup();
  assert.deepEqual(await t.call("list_alerts", {}), { alerts: [] });
  const tea = await t.call("set_timer", { seconds: 600, label: "tea", language: "en" }, "friday-hall");
  const eggs = await t.call("set_timer", { seconds: 300, label: "eggs", language: "en" });
  const wekker = await t.call("set_alarm", { time: "07:30", label: "wekker", language: "nl" });
  await t.clock.advance(210_000);
  assert.deepEqual((await t.call("list_alerts", {})).alerts, [
    { id: eggs.id, kind: "timer", label: "eggs", device: "Kitchen satellite", due: "12:05", when: "today at 12:05", seconds_left: 90, state: "scheduled" },
    { id: tea.id, kind: "timer", label: "tea", device: "Hall", due: "12:10", when: "today at 12:10", seconds_left: 390, state: "scheduled" },
    { id: wekker.id, kind: "alarm", label: "wekker", device: "Kitchen satellite", due: "07:30", when: "morgen, vrijdag 9 oktober, om 07:30", seconds_left: 69_990, state: "scheduled" },
  ]);
});

// cancel_alert

test("cancel_alert by label, by id, and the only alert without arguments", async () => {
  const t = setup();
  const eggs = await t.call("set_timer", { seconds: 300, label: "eggs", language: "en" });
  const pasta = await t.call("set_timer", { seconds: 600, label: "Pasta", language: "en" });
  assert.deepEqual(await t.call("cancel_alert", { label: "pasta" }), { cancelled: { id: pasta.id, kind: "timer", label: "Pasta", due: "12:10", when: "today at 12:10" } });
  assert.equal(t.store.get(pasta.id)!.state, "cancelled");
  assert.equal(t.store.get(eggs.id)!.state, "scheduled");
  const tea = await t.call("set_timer", { seconds: 900, label: "tea", language: "en" });
  assert.equal((await t.call("cancel_alert", { id: tea.id.toUpperCase() })).cancelled.id, tea.id);
  assert.equal((await t.call("cancel_alert", {})).cancelled.id, eggs.id);
});

test("cancel_alert by due time: 'remove the 8:30 alarm' cancels that one and keeps 07:30", async () => {
  const t = setup(NIGHT);
  const early = await t.call("set_alarm", { time: "07:30", label: "wekker", language: "nl" });
  const late = await t.call("set_alarm", { time: "08:30", language: "nl" });
  assert.equal((await t.call("cancel_alert", { due: "8:30", kind: "alarm" })).cancelled.id, late.id);
  assert.equal(t.store.get(early.id)!.state, "scheduled");
});

test("cancel_alert by kind picks the only alarm among timers", async () => {
  const t = setup();
  await t.call("set_timer", { seconds: 300, label: "pasta", language: "en" });
  const wekker = await t.call("set_alarm", { time: "07:30", label: "wekker", language: "nl" });
  assert.equal((await t.call("cancel_alert", { kind: "alarm" })).cancelled.id, wekker.id);
});

test("cancel_alert: ambiguous, unknown or a due time nobody has cancels nothing and lists the alerts with `when`", async () => {
  const t = setup(NIGHT);
  assert.match((await t.call("cancel_alert", {})).error, /No timer or alarm is set/);
  // The two timers of 13 October, due 09:30 and 10:30 local: "remove the 8:30 one" matches neither.
  const a = await t.call("set_timer", { seconds: 35_340, label: "wekker", language: "nl" });
  const b = await t.call("set_timer", { seconds: 38_940, language: "nl" });
  const none = await t.call("cancel_alert", { due: "08:30" });
  assert.match(none.error, /No alert matches\. Nothing was cancelled/);
  assert.deepEqual(none.alerts.map((x: { id: string; when: string }) => [x.id, x.when]), [
    [a.id, "morgen, woensdag 14 oktober, om 09:30"],
    [b.id, "morgen, woensdag 14 oktober, om 10:30"],
  ]);
  assert.match((await t.call("cancel_alert", { kind: "timer" })).error, /Several alerts match/);
  assert.match((await t.call("cancel_alert", { due: "half nine" })).error, /HH:MM/);
  assert.match((await t.call("cancel_alert", { kind: "reminder" })).error, /timer or alarm/);
  assert.equal(t.store.active().length, 2);
});

test("cancel_alert without arguments only reaches the calling device: 'cancel the timer' in the kitchen spares the bedroom alarm", async () => {
  const t = setup(NIGHT);
  const alarm = await t.call("set_alarm", { time: "07:00", label: "wekker", language: "nl" }, "friday-hall");
  const none = await t.call("cancel_alert", {});
  assert.match(none.error, /No alert matches\. Nothing was cancelled/);
  assert.deepEqual(none.alerts.map((x: { id: string }) => x.id), [alarm.id]);
  assert.equal(t.store.get(alarm.id)!.state, "scheduled");
  assert.match((await t.call("change_alert", { time: "08:00" })).error, /No alert matches\. Nothing was changed/);
  assert.equal((await t.call("cancel_alert", {}, "friday-hall")).cancelled.id, alarm.id, "on its own device it is the only one");
});

test("the skipped-time error reaches the model with one full stop", async () => {
  const t = setup("2026-03-28T12:00:00Z");
  const r = await t.call("set_alarm", { time: "02:30", date: "2026-03-29", language: "en" });
  assert.match(r.error, /ask for another time\. No alarm was set\.$/);
  assert.doesNotMatch(r.error, /\.\./);
});

test("cancel_alert stops a ringing alert", async () => {
  const t = setup();
  const a = await t.call("set_timer", { seconds: 60, label: "eggs", language: "en" });
  await t.clock.advance(MIN);
  assert.equal(t.store.get(a.id)!.state, "ringing");
  await t.call("cancel_alert", { label: "eggs" });
  assert.deepEqual(t.sent.map((m) => m.type), ["ring", "stop"]);
});

// change_alert

test("change_alert: 'no, the alarm should be at 7:30' moves the 08:30 alarm, keeps its id, and says what it was", async () => {
  const t = setup(NIGHT);
  const first = await t.call("set_alarm", { time: "08:30", label: "wekker", language: "nl" });
  const r = await t.call("change_alert", { kind: "alarm", time: "07:30" });
  assert.deepEqual(r, {
    changed: { id: first.id, kind: "alarm", label: "wekker", due: "07:30", when: "morgen, woensdag 14 oktober, om 07:30", was: "morgen, woensdag 14 oktober, om 08:30" },
  });
  assert.equal(t.store.active().length, 1);
  assert.equal(t.store.get(first.id)!.dueAt, "2026-10-14T05:30:00.000Z");
});

test("change_alert won't move an alarm onto another alarm of the same device", async () => {
  const t = setup(NIGHT);
  const wekker = await t.call("set_alarm", { time: "07:00", label: "wekker", language: "nl" });
  const pills = await t.call("set_alarm", { time: "07:30", label: "pills", language: "nl" });
  const r = await t.call("change_alert", { label: "pills", time: "07:00" });
  assert.match(r.error, new RegExp(`"wekker" \\(${wekker.id}\\) is already set for morgen, woensdag 14 oktober, om 07:00; cancel this one instead\\. Nothing was changed\\.`));
  assert.equal(t.store.get(pills.id)!.dueAt, "2026-10-14T05:30:00.000Z");
  await t.call("set_alarm", { time: "07:00", language: "nl" }, "friday-hall");
  assert.ok((await t.call("change_alert", { label: "wekker", time: "07:15" })).changed, "another device's 07:00 is no clash");
});

test("change_alert: a timer gets a new length from now", async () => {
  const t = setup();
  await t.call("set_timer", { seconds: 300, label: "eggs", language: "en" });
  await t.clock.advance(3 * MIN);
  const r = await t.call("change_alert", { label: "eggs", seconds: 300 });
  assert.equal(r.changed.when, "today at 12:08");
  await t.clock.advance(5 * MIN - 1);
  assert.equal(t.rings(), 0);
  await t.clock.advance(1);
  assert.equal(t.rings(), 1);
});

test("change_alert refuses a ringing alert, the wrong field for the kind, and bad values, changing nothing", async () => {
  const t = setup();
  const eggs = await t.call("set_timer", { seconds: 60, label: "eggs", language: "en" });
  const wekker = await t.call("set_alarm", { time: "07:30", label: "wekker", language: "nl" });
  assert.match((await t.call("change_alert", { kind: "alarm", seconds: 600 })).error, /not seconds/);
  assert.match((await t.call("change_alert", { label: "eggs", time: "13:00" })).error, /not a time of day/);
  assert.match((await t.call("change_alert", { label: "eggs", seconds: 0 })).error, /seconds must be/);
  assert.match((await t.call("change_alert", { kind: "alarm", time: "7:30" })).error, /HH:MM.*Nothing was changed/);
  assert.match((await t.call("change_alert", { time: "08:00" })).error, /Several alerts match.*Nothing was changed/);
  await t.clock.advance(MIN);
  assert.equal(t.store.get(eggs.id)!.state, "ringing");
  assert.match((await t.call("change_alert", { label: "eggs", seconds: 300 })).error, /is ringing; snooze or cancel/);
  assert.equal(t.store.get(eggs.id)!.state, "ringing");
  assert.equal(t.store.get(wekker.id)!.dueAt, "2026-10-09T05:30:00.000Z");
});

// snooze_alert

test("snooze_alert in the alert session rings again after the minutes given, default 5", async () => {
  const t = setup();
  const a = await t.call("set_timer", { seconds: 60, label: "eggs", language: "en" });
  await t.clock.advance(MIN);
  const claim = t.alerts.claim(KITCHEN, a.id)!;
  claim.acknowledge();
  assert.deepEqual(await t.call("snooze_alert", {}), { snoozed: ["eggs"], due: "12:06", when: "today at 12:06" });
  claim.closed();
  assert.equal(t.store.get(a.id)!.state, "scheduled");
  await t.clock.advance(5 * MIN);
  assert.equal(t.rings(), 2);
});

test("snooze_alert outside an alert session, or with bad minutes, changes nothing", async () => {
  const t = setup();
  const a = await t.call("set_timer", { seconds: 300, label: "eggs", language: "en" });
  assert.match((await t.call("snooze_alert", { minutes: 5 })).error, /Nothing is ringing/);
  assert.match((await t.call("snooze_alert", { minutes: 0 })).error, /1 to 60/);
  assert.match((await t.call("snooze_alert", { minutes: 61 })).error, /1 to 60/);
  assert.equal(t.store.get(a.id)!.dueAt, "2026-10-08T10:05:00.000Z");
});

// 13 October, replayed with the new tools.

test("13 October replayed: set 08:30, 'should be 7:30', confirm via list_alerts: one alarm, at 07:30, and it rings then", async () => {
  const t = setup(NIGHT);
  const set = await t.call("set_alarm", { time: "08:30", language: "nl" });
  assert.equal(set.when, "morgen, woensdag 14 oktober, om 08:30");
  await t.clock.advance(12_000);
  const changed = await t.call("change_alert", { id: set.id, time: "07:30" });
  assert.equal(changed.changed.when, "morgen, woensdag 14 oktober, om 07:30");
  await t.clock.advance(27_000);
  const listed = (await t.call("list_alerts", {})).alerts;
  assert.equal(listed.length, 1, "exactly one alarm");
  assert.deepEqual([listed[0].kind, listed[0].when], ["alarm", "morgen, woensdag 14 oktober, om 07:30"]);
  await t.clock.to("2026-10-14T05:30:00Z");
  assert.equal(t.rings(), 1, "rings at 07:30 local");
  assert.equal(t.store.get(set.id)!.state, "ringing");
});
