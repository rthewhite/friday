import { test } from "node:test";
import assert from "node:assert/strict";
import { RunStore } from "../src/nightly/runs.js";
import { brainStore } from "./fixtures.js";

test("a started and finished run round-trips, and its revision range brackets what was written in between", (t) => {
  const { store, db, close } = brainStore();
  t.after(close);
  const runs = new RunStore(db, () => new Date("2026-09-30T01:00:00Z"));
  store.create({ name: "Before" }, "user");
  const run = runs.start("schedule");
  assert.equal(run.outcome, undefined);
  assert.equal(run.trigger, "schedule");
  const a = store.create({ name: "Anouk", body: "x" }, "extraction");
  const b = store.save(a.id, { ...a, body: "y" }, "consolidation");
  const done = runs.finish(run.id, {
    outcome: "partial",
    conversations: 5,
    skipped: 2,
    notes: 4,
    refused: 1,
    rewrites: 3,
    creates: 1,
    mergeRecords: [{ from: "p9", into: a.id }],
    dropped: [{ pageId: a.id, page: "Anouk", line: "Lives in Amsterdam", reason: "superseded" }],
    error: "model unavailable",
  });
  assert.deepEqual(runs.get(run.id), done);
  assert.equal(done.outcome, "partial");
  assert.deepEqual([done.conversations, done.skipped, done.notes, done.refused, done.rewrites, done.creates, done.merges], [5, 2, 4, 1, 3, 1, 1]);
  assert.equal(done.finishedAt, "2026-09-30T01:00:00.000Z");
  assert.equal(done.firstRevisionId, a.revisionId);
  assert.equal(done.lastRevisionId, b.revisionId);
  assert.equal(done.error, "model unavailable");
  assert.deepEqual(runs.list().map((r) => r.id), [run.id]);
});

test("the revision range stays correct after a purge freed the newest ids", (t) => {
  const { store, db, close } = brainStore();
  t.after(close);
  const runs = new RunStore(db);
  const gone = store.create({ name: "Gone" }, "user");
  store.softDelete(gone.id, "user");
  const highest = store.get(gone.id)!.revisionId;
  store.purge(gone.id, "Gone", "user");
  const run = runs.start("manual");
  assert.ok(run.firstRevisionId > highest);
  const next = store.create({ name: "Next" }, "extraction");
  assert.equal(next.revisionId, run.firstRevisionId);
  assert.equal(runs.finish(run.id, { outcome: "ok" }).lastRevisionId, next.revisionId);
});

test("a run that writes nothing has an empty range, and runs list newest first", (t) => {
  const { db, close } = brainStore();
  t.after(close);
  const runs = new RunStore(db);
  const first = runs.finish(runs.start("schedule").id, { outcome: "ok" });
  assert.equal(first.lastRevisionId, first.firstRevisionId - 1);
  const second = runs.finish(runs.start("manual").id, { outcome: "failed", error: "boom" });
  assert.deepEqual(runs.list().map((r) => r.id), [second.id, first.id]);
  assert.deepEqual(runs.list(1).map((r) => r.id), [second.id]);
});
