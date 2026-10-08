import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { migrate, migrations } from "../src/storage/db.js";
import { AlertStore, KEEP_FINISHED, type NewAlert } from "../src/alerts/store.js";

const quiet = { log() {} };
const kitchen = { kind: "device" as const, id: "friday-kitchen" };

function setup(opts: { random?: (max: number) => number } = {}) {
  const db = new DatabaseSync(":memory:");
  migrate(db, migrations, quiet);
  const clock = { t: Date.parse("2026-10-08T12:00:00Z") };
  const store = new AlertStore(db, { now: () => new Date(clock.t), ...opts });
  const timer = (over: Partial<NewAlert> = {}) =>
    store.create({ kind: "timer", label: "eggs", language: "nl", dueAt: new Date(clock.t + 300_000), target: kitchen, ...over });
  return { db, clock, store, timer };
}

test("a created timer is scheduled, due and next rung at its due time, with a short id", () => {
  const { store, timer } = setup();
  const a = timer({ conversationId: "c1" });
  assert.match(a.id, /^[2-9a-z]{4}$/);
  assert.deepEqual(store.get(a.id), {
    id: a.id,
    kind: "timer",
    label: "eggs",
    language: "nl",
    dueAt: "2026-10-08T12:05:00.000Z",
    nextRingAt: "2026-10-08T12:05:00.000Z",
    target: kitchen,
    state: "scheduled",
    rings: 0,
    local: false,
    createdAt: "2026-10-08T12:00:00.000Z",
    conversationId: "c1",
    snoozedAt: null,
    finishedAt: null,
  });
});

test("ids are never reused while a stored alert has them", () => {
  // The first two draws spell the same id; the store must draw again for the second alert.
  const draws = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1];
  const { timer } = setup({ random: () => draws.shift() ?? 2 });
  const a = timer();
  const b = timer();
  assert.equal(a.id, "2222");
  assert.equal(b.id, "3333");
});

test("a snooze is stored with the alert", () => {
  const { store, timer, clock } = setup();
  const a = timer();
  const at = new Date(clock.t + 300_000);
  assert.equal(store.update(a.id, { state: "scheduled", dueAt: new Date(at.getTime() + 120_000), snoozedAt: at })!.snoozedAt, at.toISOString());
  assert.equal(store.update(a.id, { rings: 1 })!.snoozedAt, at.toISOString(), "a later update keeps it");
});

test("update() moves times and counters, and a final state stamps finished_at once", () => {
  const { store, timer, clock } = setup();
  const a = timer();
  store.update(a.id, { state: "ringing", rings: 2, nextRingAt: new Date(clock.t + 360_000) });
  assert.deepEqual({ ...store.get(a.id)!, target: undefined }, { ...a, target: undefined, state: "ringing", rings: 2, nextRingAt: "2026-10-08T12:06:00.000Z" });
  clock.t += 1000;
  store.update(a.id, { state: "missed" });
  assert.equal(store.get(a.id)!.finishedAt, "2026-10-08T12:00:01.000Z");
  clock.t += 1000;
  store.update(a.id, { local: false });
  assert.equal(store.get(a.id)!.finishedAt, "2026-10-08T12:00:01.000Z", "a later update keeps the first finish time");
  assert.equal(store.update("nope", { state: "missed" }), undefined);
});

test("snoozing back to scheduled clears finished_at", () => {
  const { store, timer, clock } = setup();
  const a = timer();
  store.update(a.id, { state: "ringing", rings: 1 });
  const later = new Date(clock.t + 900_000);
  const s = store.update(a.id, { state: "scheduled", dueAt: later, nextRingAt: later, rings: 0 })!;
  assert.equal(s.state, "scheduled");
  assert.equal(s.dueAt, later.toISOString());
  assert.equal(s.finishedAt, null);
});

test("list() shows active alerts by due time, then finished ones newest first", () => {
  const { store, timer, clock } = setup();
  const pasta = timer({ label: "pasta", dueAt: new Date(clock.t + 900_000) });
  const eggs = timer();
  const tea = timer({ label: "tea" });
  const rice = timer({ label: "rice" });
  store.update(tea.id, { state: "missed" });
  clock.t += 1000;
  store.update(rice.id, { state: "cancelled" });
  assert.deepEqual(store.list().map((a) => a.label), ["eggs", "pasta", "rice", "tea"]);
  assert.deepEqual(store.active().map((a) => a.id), [eggs.id, pasta.id]);
});

test("active() narrows to a target, and cancelTarget() cancels only that target's active alerts", () => {
  const { store, timer } = setup();
  const eggs = timer();
  const bedroom = timer({ label: "nap", target: { kind: "device", id: "friday-bedroom" } });
  const done = timer({ label: "tea" });
  store.update(done.id, { state: "acknowledged" });
  assert.deepEqual(store.active(kitchen).map((a) => a.id), [eggs.id]);
  assert.deepEqual(store.cancelTarget(kitchen).map((a) => [a.id, a.state]), [[eggs.id, "cancelled"]]);
  assert.equal(store.get(bedroom.id)!.state, "scheduled");
  assert.equal(store.get(done.id)!.state, "acknowledged");
});

test("resetLocal() clears every local flag", () => {
  const { store, timer } = setup();
  const a = timer();
  store.update(a.id, { state: "ringing", local: true });
  store.resetLocal();
  assert.equal(store.get(a.id)!.local, false);
});

test("only the newest finished alerts are kept, active ones never pruned", () => {
  const { store, timer, clock } = setup();
  const active = timer({ label: "running" });
  const first = timer({ label: "oldest" });
  store.update(first.id, { state: "missed" });
  for (let i = 0; i < KEEP_FINISHED; i++) {
    clock.t += 1000;
    store.update(timer({ label: `t${i}` }).id, { state: "acknowledged" });
  }
  assert.equal(store.get(first.id), undefined, "the oldest finished alert was pruned");
  assert.equal(store.list().filter((a) => a.finishedAt).length, KEEP_FINISHED);
  assert.equal(store.get(active.id)!.state, "scheduled");
});
