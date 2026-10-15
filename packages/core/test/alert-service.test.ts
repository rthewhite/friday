import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { migrate, migrations } from "../src/storage/db.js";
import { AlertStore, type NewAlert } from "../src/alerts/store.js";
import { AlertConflict, AlertNotFound, AlertService, ANSWER_TIMEOUT_MS, LOCAL_RING_MAX_MS } from "../src/alerts/service.js";
import { DeviceLinks } from "../src/devices/links.js";
import { DeviceSessions } from "../src/devices/sessions.js";
import { FakeClock } from "./fake-clock.js";

const quiet = { log() {}, error() {} };
const KITCHEN = "friday-kitchen";
const MIN = 60_000;

class FakeSocket {
  sent: { type: string; data: { alert: string } }[] = [];
  send(d: string) {
    this.sent.push(JSON.parse(d));
  }
  close() {}
  rings = () => this.sent.filter((m) => m.type === "ring").map((m) => m.data.alert);
  stops = () => this.sent.filter((m) => m.type === "stop").map((m) => m.data.alert);
}

function setup(opts: { online?: boolean; db?: DatabaseSync; clock?: FakeClock; ringIntervalMs?: number } = {}) {
  const db = opts.db ?? new DatabaseSync(":memory:");
  if (!opts.db) migrate(db, migrations, quiet);
  const clock = opts.clock ?? new FakeClock(Date.parse("2026-10-08T10:00:00Z"));
  const store = new AlertStore(db, { now: () => new Date(clock.now()) });
  const links = new DeviceLinks();
  const sessions = new DeviceSessions();
  const service = new AlertService({ store, links, sessions, clock, log: quiet, timezone: () => "Europe/Amsterdam", rings: 5, ringIntervalMs: opts.ringIntervalMs ?? MIN, graceMs: 10 * MIN, alarmWindowMs: 30 * MIN });
  const device = new FakeSocket();
  if (opts.online ?? true) links.add(KITCHEN, device);
  const timer = (over: Partial<NewAlert> = {}) =>
    service.create({ kind: "timer", label: "eggs", language: "nl", dueAt: new Date(clock.now() + 5 * MIN), target: { kind: "device", id: KITCHEN }, ...over });
  const state = (id: string) => store.get(id)!.state;
  return { db, clock, store, links, sessions, service, device, timer, state };
}

test("a timer rings its device when due, and not before", async () => {
  const t = setup();
  t.service.start();
  const a = t.timer();
  await t.clock.advance(5 * MIN - 1);
  assert.deepEqual(t.device.rings(), []);
  await t.clock.advance(1);
  assert.deepEqual(t.device.rings(), [a.id]);
  assert.equal(t.state(a.id), "ringing");
  t.service.stop();
});

test("two timers due at once give one ring, and the alert session announces both", async () => {
  const t = setup();
  t.service.start();
  const eggs = t.timer();
  const pasta = t.timer({ label: "pasta", dueAt: new Date(t.clock.now() + 5 * MIN) });
  await t.clock.advance(5 * MIN);
  const rings = t.device.rings();
  assert.equal(rings.length, 1);
  assert.ok([eggs.id, pasta.id].includes(rings[0]));
  const claim = t.service.claim(KITCHEN, rings[0])!;
  assert.deepEqual(claim.alerts.map((a) => a.label).sort(), ["eggs", "pasta"]);
  assert.match(claim.text, /^Alerts: the timer "(eggs|pasta)".*; the timer "(eggs|pasta)"/);
  assert.equal(t.state(eggs.id), "ringing");
  assert.equal(t.state(pasta.id), "ringing");
  t.service.stop();
});

test("a device in a conversation is rung when its conversation ends", async () => {
  const t = setup();
  t.service.start();
  const a = t.timer();
  const audio = new FakeSocket();
  t.sessions.add(KITCHEN, audio);
  await t.clock.advance(6 * MIN);
  assert.deepEqual(t.device.rings(), []);
  t.sessions.remove(KITCHEN, audio);
  assert.deepEqual(t.device.rings(), [a.id]);
  t.service.stop();
});

test("a device that comes online is rung right away", async () => {
  const t = setup({ online: false });
  t.service.start();
  const a = t.timer();
  await t.clock.advance(5 * MIN + 20_000);
  const device = new FakeSocket();
  t.links.add(KITCHEN, device);
  assert.deepEqual(device.rings(), [a.id]);
  t.service.stop();
});

test("answered at once: acknowledged, the device is told to stop, and it never rings again", async () => {
  const t = setup();
  t.service.start();
  const a = t.timer();
  await t.clock.advance(5 * MIN);
  const claim = t.service.claim(KITCHEN, a.id)!;
  assert.match(claim.text, /^Alert: the timer "eggs" \(5 minutes, set at 12:00\) went off at 12:05\. .*in Dutch/);
  claim.acknowledge();
  claim.closed();
  assert.equal(t.state(a.id), "acknowledged");
  assert.deepEqual(t.device.stops(), [a.id]);
  await t.clock.advance(30 * MIN);
  assert.deepEqual(t.device.rings(), [a.id]);
  t.service.stop();
});

test("nobody in the kitchen: five unanswered rings a minute apart, then missed and no sixth", async () => {
  const t = setup();
  t.service.start();
  const a = t.timer();
  await t.clock.advance(5 * MIN);
  for (let ring = 1; ring <= 5; ring++) {
    assert.equal(t.device.rings().length, ring);
    // Alternate: the device opens a session nobody answers, or doesn't open one at all.
    if (ring % 2) t.service.claim(KITCHEN, a.id)!.closed();
    else await t.clock.advance(ANSWER_TIMEOUT_MS);
    assert.equal(t.store.get(a.id)!.rings, ring);
    if (ring < 5) {
      assert.equal(t.state(a.id), "ringing");
      await t.clock.advance(MIN);
    }
  }
  assert.equal(t.state(a.id), "missed");
  await t.clock.advance(30 * MIN);
  assert.equal(t.device.rings().length, 5);
  t.service.stop();
});

test("answered on the third ring", async () => {
  const t = setup();
  t.service.start();
  const a = t.timer();
  await t.clock.advance(5 * MIN);
  t.service.claim(KITCHEN, a.id)!.closed();
  await t.clock.advance(MIN);
  await t.clock.advance(ANSWER_TIMEOUT_MS);
  await t.clock.advance(MIN);
  assert.equal(t.device.rings().length, 3);
  const claim = t.service.claim(KITCHEN, a.id)!;
  claim.acknowledge();
  claim.closed();
  assert.equal(t.state(a.id), "acknowledged");
  t.service.stop();
});

test("a claim needs the alert ringing on that very device, and one alert session per device", async () => {
  const t = setup();
  t.service.start();
  const a = t.timer();
  assert.equal(t.service.claim(KITCHEN, a.id), undefined, "not ringing yet");
  await t.clock.advance(5 * MIN);
  assert.equal(t.service.claim("friday-bedroom", a.id), undefined);
  assert.equal(t.service.claim(KITCHEN, "nope"), undefined);
  assert.ok(t.service.claim(KITCHEN, a.id));
  assert.equal(t.service.claim(KITCHEN, a.id), undefined, "already answered");
  t.service.stop();
});

test("a device ringing an alert locally stops server rings and reports the outcome", async () => {
  const t = setup();
  t.service.start();
  const stopped = t.timer();
  const ranOut = t.timer({ label: "pasta", dueAt: new Date(t.clock.now() + 8 * MIN) });
  await t.clock.advance(5 * MIN);
  t.service.deviceReport(KITCHEN, "ringing_locally", stopped.id);
  assert.equal(t.store.get(stopped.id)!.local, true);
  await t.clock.advance(3 * MIN);
  t.service.deviceReport(KITCHEN, "ringing_locally", ranOut.id);
  await t.clock.advance(20 * MIN);
  assert.deepEqual(t.device.rings(), [stopped.id, ranOut.id], "no ring after a local ring started, not even past grace");
  assert.equal(t.state(stopped.id), "ringing");
  t.service.deviceReport(KITCHEN, "acknowledged", stopped.id);
  t.service.deviceReport(KITCHEN, "unanswered", ranOut.id);
  assert.equal(t.state(stopped.id), "acknowledged");
  assert.equal(t.state(ranOut.id), "missed");
  t.service.stop();
});

test("reports about alerts not ringing on that device are ignored", async () => {
  const t = setup();
  t.service.start();
  const a = t.timer();
  t.service.deviceReport(KITCHEN, "acknowledged", a.id);
  assert.equal(t.state(a.id), "scheduled", "not ringing yet");
  await t.clock.advance(5 * MIN);
  t.service.deviceReport("friday-bedroom", "acknowledged", a.id);
  t.service.deviceReport("friday-bedroom", "unanswered", a.id);
  t.service.deviceReport(KITCHEN, "acknowledged", "nope");
  assert.equal(t.state(a.id), "ringing");
  t.service.deviceReport(KITCHEN, "acknowledged", a.id);
  assert.equal(t.state(a.id), "acknowledged");
  t.service.stop();
});

test("the device's own ring running out makes an alert missed, even when Friday no longer knew it rang locally", async () => {
  const t = setup();
  t.service.start();
  const a = t.timer();
  await t.clock.advance(5 * MIN);
  t.service.deviceReport(KITCHEN, "unanswered", a.id);
  assert.equal(t.state(a.id), "missed");
  t.service.stop();
});

test("a claim for an alert the device rings itself is refused, and leaves the device free to be rung", async () => {
  const t = setup();
  t.service.start();
  const a = t.timer();
  await t.clock.advance(5 * MIN);
  t.service.deviceReport(KITCHEN, "ringing_locally", a.id);
  assert.equal(t.service.claim(KITCHEN, a.id), undefined);
  const b = t.timer({ label: "pasta", dueAt: new Date(t.clock.now() + MIN) });
  await t.clock.advance(MIN);
  assert.deepEqual(t.device.rings(), [a.id, b.id], "no claim was left behind blocking the next ring");
  t.service.stop();
});

test("the button during a session announcing two timers acknowledges both", async () => {
  const t = setup();
  t.service.start();
  const eggs = t.timer();
  const pasta = t.timer({ label: "pasta" });
  await t.clock.advance(5 * MIN);
  const claim = t.service.claim(KITCHEN, t.device.rings()[0])!;
  t.service.deviceReport(KITCHEN, "acknowledged", t.device.rings()[0]); // the firmware names only the alert it was rung for
  claim.closed();
  assert.equal(t.state(eggs.id), "acknowledged");
  assert.equal(t.state(pasta.id), "acknowledged");
  await t.clock.advance(5 * MIN);
  assert.equal(t.device.rings().length, 1, "nothing rings again");
  t.service.stop();
});

test("when a device ringing locally reconnects, its alerts ring again so it can report afresh", async () => {
  const t = setup();
  t.service.start();
  const a = t.timer();
  await t.clock.advance(5 * MIN);
  t.service.deviceReport(KITCHEN, "ringing_locally", a.id);
  t.links.remove(KITCHEN, t.device as never); // the control connection drops, a report may be lost
  const again = new FakeSocket();
  t.links.add(KITCHEN, again);
  assert.equal(t.store.get(a.id)!.local, false);
  assert.deepEqual(again.rings(), [a.id]);
  t.service.deviceReport(KITCHEN, "ringing_locally", a.id); // still ringing: it says so again
  assert.equal(t.store.get(a.id)!.local, true);
  t.service.stop();
});

test("a local ring nobody reports on is missed after the longest a device may ring", async () => {
  const t = setup();
  t.service.start();
  const a = t.timer();
  await t.clock.advance(5 * MIN);
  t.service.deviceReport(KITCHEN, "ringing_locally", a.id);
  await t.clock.advance(LOCAL_RING_MAX_MS - 1);
  assert.equal(t.state(a.id), "ringing");
  await t.clock.advance(1);
  assert.equal(t.state(a.id), "missed");
  t.service.stop();
});

test("a database error in the service is logged, not thrown, and the service tries again", async () => {
  const t = setup();
  const errors: unknown[] = [];
  const service = new AlertService({
    store: t.store,
    links: t.links,
    sessions: t.sessions,
    clock: t.clock,
    log: { log() {}, error: (...a: unknown[]) => void errors.push(a) },
    timezone: () => "Europe/Amsterdam",
    rings: 5,
    ringIntervalMs: MIN,
    graceMs: 10 * MIN,
  });
  const a = t.store.create({ kind: "timer", label: "eggs", language: "en", dueAt: new Date(t.clock.now() + MIN), target: { kind: "device", id: KITCHEN } });
  const active = t.store.active.bind(t.store);
  let failing = true;
  t.store.active = ((target) => {
    if (failing && !target) throw new Error("database is locked");
    return active(target);
  }) as typeof t.store.active;
  service.start(); // neither the startup reset nor the tick may throw
  assert.equal(errors.length, 2);
  failing = false;
  await t.clock.advance(MIN);
  assert.deepEqual(t.device.rings(), [a.id], "the retry rang it");
  service.stop();
});

test("the button pressed during an alert session acknowledges, and the session closing then is no unanswered ring", async () => {
  const t = setup();
  t.service.start();
  const a = t.timer();
  await t.clock.advance(5 * MIN);
  const claim = t.service.claim(KITCHEN, a.id)!;
  t.service.deviceReport(KITCHEN, "acknowledged", a.id);
  claim.closed();
  assert.equal(t.state(a.id), "acknowledged");
  assert.equal(t.store.get(a.id)!.rings, 0);
  t.service.stop();
});

test("restart before the due time: the timer is still scheduled and rings on time", async () => {
  const first = setup();
  first.service.start();
  const a = first.timer();
  await first.clock.advance(2 * MIN);
  first.service.stop();
  const t = setup({ db: first.db, clock: first.clock });
  t.service.start();
  assert.equal(t.state(a.id), "scheduled");
  await t.clock.advance(3 * MIN - 1);
  assert.deepEqual(t.device.rings(), []);
  await t.clock.advance(1);
  assert.deepEqual(t.device.rings(), [a.id]);
  t.service.stop();
});

test("short restart: an alert due while Friday was down rings right after startup, saying how late it is", async () => {
  const first = setup();
  first.service.start();
  const a = first.timer();
  first.service.stop();
  await first.clock.advance(7 * MIN);
  const t = setup({ db: first.db, clock: first.clock });
  t.service.start();
  assert.deepEqual(t.device.rings(), [a.id]);
  assert.match(t.service.claim(KITCHEN, a.id)!.text, /went off at 12:05, 2 minutes ago/);
  t.service.stop();
});

test("long outage: an alert past its grace limit at startup is missed and never rings", async () => {
  const first = setup();
  first.service.start();
  const a = first.timer();
  first.service.stop();
  await first.clock.advance(30 * MIN);
  const t = setup({ db: first.db, clock: first.clock });
  t.service.start();
  assert.deepEqual(t.device.rings(), []);
  assert.equal(t.state(a.id), "missed");
  t.service.stop();
});

test("a device offline past the grace limit misses its alert", async () => {
  const t = setup({ online: false });
  t.service.start();
  const a = t.timer();
  await t.clock.advance(5 * MIN + 10 * MIN - 1);
  assert.equal(t.state(a.id), "scheduled");
  await t.clock.advance(1);
  assert.equal(t.state(a.id), "missed");
  t.service.stop();
});

test("an alert waiting between rings is missed at its grace limit, but an alert session open then is not cut off", async () => {
  const t = setup({ ringIntervalMs: 4 * MIN });
  t.service.start();
  const a = t.timer();
  const b = t.timer({ label: "tea", dueAt: new Date(t.clock.now() + 6 * MIN), target: { kind: "device", id: "friday-hall" } });
  t.links.add("friday-hall", new FakeSocket());
  await t.clock.advance(5 * MIN);
  t.service.claim(KITCHEN, a.id)!.closed(); // rings again at +4 and +8; +12 would be past grace (10)
  await t.clock.advance(MIN);
  const hallClaim = t.service.claim("friday-hall", b.id)!;
  await t.clock.advance(9 * MIN); // 15 min after a was due, 10 after b was due
  assert.equal(t.state(a.id), "missed");
  assert.equal(t.device.rings().length, 3, "rang at +0, +4 and +8, then missed at its grace limit");
  assert.equal(t.state(b.id), "ringing", "the open alert session is not cut off");
  hallClaim.acknowledge();
  assert.equal(t.state(b.id), "acknowledged");
  t.service.stop();
});

test("startup clears local flags and rings again what was ringing", async () => {
  const first = setup();
  first.service.start();
  const a = first.timer();
  await first.clock.advance(5 * MIN);
  first.service.deviceReport(KITCHEN, "ringing_locally", a.id);
  first.service.stop();
  const t = setup({ db: first.db, clock: first.clock });
  t.service.start();
  assert.equal(t.store.get(a.id)!.local, false);
  assert.deepEqual(t.device.rings(), [a.id]);
  t.service.stop();
});

test("cancel: a scheduled timer never rings, a ringing one is told to stop, a finished or unknown one fails", async () => {
  const t = setup();
  t.service.start();
  const eggs = t.timer();
  const pasta = t.timer({ label: "pasta", dueAt: new Date(t.clock.now() + 2 * MIN) });
  assert.equal(t.service.cancel(eggs.id).state, "cancelled");
  await t.clock.advance(2 * MIN);
  assert.deepEqual(t.device.rings(), [pasta.id]);
  t.service.cancel(pasta.id);
  assert.deepEqual(t.device.stops(), [pasta.id]);
  await t.clock.advance(10 * MIN);
  assert.deepEqual(t.device.rings(), [pasta.id]);
  assert.throws(() => t.service.cancel(eggs.id), AlertConflict);
  assert.throws(() => t.service.cancel("nope"), AlertNotFound);
  t.service.stop();
});

test("snooze: the alert session's alerts are due again later with rings reset, and ring then", async () => {
  const t = setup();
  t.service.start();
  const a = t.timer();
  await t.clock.advance(5 * MIN);
  t.service.claim(KITCHEN, a.id)!.closed(); // one unanswered ring
  await t.clock.advance(MIN);
  const claim = t.service.claim(KITCHEN, a.id)!;
  claim.acknowledge(); // the user said "snooze two minutes"
  const [snoozed] = t.service.snooze(KITCHEN, 2);
  claim.closed();
  assert.deepEqual({ state: snoozed.state, dueAt: snoozed.dueAt, rings: snoozed.rings, finishedAt: snoozed.finishedAt }, { state: "scheduled", dueAt: "2026-10-08T10:08:00.000Z", rings: 0, finishedAt: null });
  await t.clock.advance(2 * MIN - 1);
  assert.equal(t.device.rings().length, 2);
  await t.clock.advance(1);
  assert.equal(t.device.rings().length, 3);
  t.service.stop();
});

test("snooze outside an alert session fails", async () => {
  const t = setup();
  t.service.start();
  t.timer();
  assert.throws(() => t.service.snooze(KITCHEN, 5), AlertNotFound);
  assert.throws(() => t.service.snooze(undefined, 5), /nothing is ringing/);
  t.service.stop();
});

test("cancelDevice cancels the deleted device's alerts", async () => {
  const t = setup();
  t.service.start();
  const a = t.timer();
  assert.deepEqual(t.service.cancelDevice(KITCHEN).map((x) => x.id), [a.id]);
  assert.equal(t.state(a.id), "cancelled");
  await t.clock.advance(10 * MIN);
  assert.deepEqual(t.device.rings(), []);
  t.service.stop();
});

// Alarms: setup() gives them a 30-minute window; t.timer(alarm) is due at 12:05 local.
const alarm = { kind: "alarm" as const, label: "wekker" };

test("an alarm keeps ringing past the fifth unanswered ring, a minute after each, and is acknowledged at +10", async () => {
  const t = setup();
  t.service.start();
  const a = t.timer(alarm);
  await t.clock.advance(5 * MIN);
  for (let ring = 1; ring <= 7; ring++) {
    assert.equal(t.device.rings().length, ring);
    t.service.claim(KITCHEN, a.id)!.closed();
    assert.equal(t.state(a.id), "ringing", `still ringing after ${ring} unanswered rings`);
    await t.clock.advance(MIN);
  }
  assert.equal(t.device.rings().length, 8);
  await t.clock.advance(2 * MIN); // 10 minutes after due: the device rings again and is answered
  assert.equal(t.device.rings().length, 9);
  const claim = t.service.claim(KITCHEN, a.id)!;
  claim.acknowledge();
  claim.closed();
  assert.equal(t.state(a.id), "acknowledged");
  await t.clock.advance(30 * MIN);
  assert.equal(t.device.rings().length, 9);
  t.service.stop();
});

test("an alarm nobody answers is missed when its window ends, and rings no more", async () => {
  const t = setup();
  t.service.start();
  const a = t.timer(alarm);
  await t.clock.advance(5 * MIN); // due
  // The device never opens a session: a ring every 15 s answer timeout + 1 minute interval.
  await t.clock.advance(30 * MIN - 1);
  assert.equal(t.state(a.id), "ringing");
  assert.ok(t.device.rings().length > 20, `${t.device.rings().length} rings in the window`);
  // One more ring may start at the very limit, and is not cut off.
  await t.clock.advance(2 * MIN);
  assert.equal(t.state(a.id), "missed");
  const rings = t.device.rings().length;
  assert.equal(rings, 25, "a ring every 75 seconds, from due up to and including the limit");
  await t.clock.advance(30 * MIN);
  assert.equal(t.device.rings().length, rings);
  t.service.stop();
});

test("after an outage an alarm within its window rings at once and one past it is missed, while a timer is long missed", async () => {
  const first = setup();
  first.service.start();
  const a = first.timer(alarm);
  const early = first.timer({ ...alarm, label: "early", dueAt: new Date(first.clock.now() - 35 * MIN) });
  const eggs = first.timer();
  first.service.stop();
  await first.clock.advance(20 * MIN); // a and eggs due 15 minutes ago, early 55
  const t = setup({ db: first.db, clock: first.clock });
  t.service.start();
  assert.deepEqual(t.device.rings(), [a.id]);
  assert.match(t.service.claim(KITCHEN, a.id)!.text, /15 minutes ago/);
  assert.equal(t.state(early.id), "missed");
  assert.equal(t.state(eggs.id), "missed", "a timer's grace is 10 minutes");
  t.service.stop();
});

test("a snoozed alarm's window counts from its new due time", async () => {
  const t = setup();
  t.service.start();
  const a = t.timer(alarm);
  await t.clock.advance(5 * MIN); // due, rings
  await t.clock.advance(20 * MIN); // unanswered rings until 20 minutes after due
  const ringing = t.device.rings().length;
  await t.clock.advance(ANSWER_TIMEOUT_MS + MIN); // the next ring
  assert.equal(t.device.rings().length, ringing + 1);
  const claim = t.service.claim(KITCHEN, a.id)!;
  claim.acknowledge();
  t.service.snooze(KITCHEN, 20);
  claim.closed();
  const due = Date.parse(t.store.get(a.id)!.dueAt);
  await t.clock.advance(due - t.clock.now() + 25 * MIN); // ~66 minutes after the first due time
  assert.equal(t.state(a.id), "ringing", "still ringing, 25 minutes into its new window");
  t.service.stop();
});

test("an alarm's local tone running out is one more unanswered ring, and it rings again a minute later", async () => {
  const t = setup();
  t.service.start();
  const a = t.timer(alarm);
  await t.clock.advance(5 * MIN);
  t.service.deviceReport(KITCHEN, "ringing_locally", a.id);
  await t.clock.advance(5 * MIN);
  assert.equal(t.device.rings().length, 1);
  t.service.deviceReport(KITCHEN, "unanswered", a.id);
  const now = t.store.get(a.id)!;
  assert.deepEqual({ state: now.state, local: now.local, rings: now.rings }, { state: "ringing", local: false, rings: 1 });
  await t.clock.advance(MIN);
  assert.equal(t.device.rings().length, 2);
  t.service.stop();
});

test("an alarm's local tone running out after its window makes it missed", async () => {
  const t = setup();
  t.service.start();
  const a = t.timer(alarm);
  await t.clock.advance(5 * MIN + 28 * MIN);
  t.service.deviceReport(KITCHEN, "ringing_locally", a.id);
  await t.clock.advance(5 * MIN); // the device's ring_limit: 33 minutes after due
  const rings = t.device.rings().length;
  t.service.deviceReport(KITCHEN, "unanswered", a.id);
  await t.clock.advance(MIN);
  assert.equal(t.state(a.id), "missed");
  assert.equal(t.device.rings().length, rings);
  t.service.stop();
});

test("reschedule: a moved alert rings at its new time, not the old one; a ringing or unknown one is refused", async () => {
  const t = setup();
  t.service.start();
  const a = t.timer(alarm); // due at 10:05Z
  await t.clock.advance(MIN);
  const moved = t.service.reschedule(a.id, new Date(t.clock.now() + 10 * MIN));
  assert.deepEqual(
    { id: moved.id, state: moved.state, dueAt: moved.dueAt, nextRingAt: moved.nextRingAt, rings: moved.rings },
    { id: a.id, state: "scheduled", dueAt: "2026-10-08T10:11:00.000Z", nextRingAt: "2026-10-08T10:11:00.000Z", rings: 0 },
  );
  await t.clock.advance(10 * MIN - 1);
  assert.deepEqual(t.device.rings(), [], "not at the old time");
  await t.clock.advance(1);
  assert.deepEqual(t.device.rings(), [a.id]);
  assert.throws(() => t.service.reschedule(a.id, new Date(t.clock.now() + MIN)), AlertConflict);
  assert.throws(() => t.service.reschedule("nope", new Date()), AlertNotFound);
  t.service.stop();
});

test("a moved timer is announced as set again at the move, not with its whole span since it was set", async () => {
  const t = setup();
  t.service.start();
  const a = t.timer(); // 12:00, 5 minutes
  await t.clock.advance(3 * MIN);
  t.service.reschedule(a.id, new Date(t.clock.now() + 20 * MIN)); // 12:03, now 20 minutes
  await t.clock.advance(20 * MIN);
  assert.match(t.service.claim(KITCHEN, a.id)!.text, /the timer "eggs" \(set again for 20 minutes at 12:03\) went off at 12:23\./);
  t.service.stop();
});

test("an alarm snoozed earlier and then moved is announced for its new time, not as snoozed", async () => {
  const t = setup();
  t.service.start();
  const a = t.timer(alarm); // due 12:05
  await t.clock.advance(5 * MIN);
  const claim = t.service.claim(KITCHEN, a.id)!;
  claim.acknowledge();
  t.service.snooze(KITCHEN, 5);
  claim.closed();
  assert.ok(t.store.get(a.id)!.snoozedAt);
  t.service.reschedule(a.id, new Date("2026-10-08T18:00:00Z")); // 20:00 local
  assert.equal(t.store.get(a.id)!.snoozedAt, null);
  await t.clock.to("2026-10-08T18:00:00Z");
  assert.match(t.service.claim(KITCHEN, a.id)!.text, /^Alert: the alarm "wekker" for 20:00 went off\./);
  t.service.stop();
});
