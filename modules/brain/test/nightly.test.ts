import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestHost } from "@friday/sdk/test";
import { createBrainModule } from "../src/index.js";
import { summarize } from "../src/nightly/job.js";

test("brain/nightly is scheduled at 03:00 by default, from BRAIN_NIGHTLY_CRON, and not at all when off", async () => {
  assert.deepEqual((await createTestHost(createBrainModule())).jobs, [{ name: "nightly", cron: "0 3 * * *" }]);
  assert.deepEqual((await createTestHost(createBrainModule(), { env: { BRAIN_NIGHTLY_CRON: "30 4 * * *" } })).jobs, [{ name: "nightly", cron: "30 4 * * *" }]);
  assert.deepEqual((await createTestHost(createBrainModule(), { env: { BRAIN_NIGHTLY_CRON: "off" } })).jobs, []);
  // A typo disables only the job; the brain's tools and context still load.
  const errors: string[] = [];
  const bad = await createTestHost(createBrainModule(), { env: { BRAIN_NIGHTLY_CRON: "0 3 * *" }, log: { log() {}, warn() {}, error: (...a) => void errors.push(a.join(" ")) } });
  assert.deepEqual(bad.jobs, []);
  assert.deepEqual(bad.tools, ["brain_remember", "brain_recall"]);
  assert.match(errors.join("\n"), /nightly maintenance is disabled: job brain\/nightly: invalid cron "0 3 \* \*".*fix BRAIN_NIGHTLY_CRON/);
});

test("a run on an empty brain is ok with a zero-count summary and is recorded", async () => {
  const h = await createTestHost(createBrainModule());
  const r = await h.runJob("nightly");
  assert.deepEqual(r, { outcome: "ok", summary: "0 conversations (0 trivial), 0 notes; nothing to consolidate" });
  const rows = h.db.prepare("SELECT trigger, outcome, conversations FROM brain__runs").all().map((x) => ({ ...x }));
  assert.deepEqual(rows, [{ trigger: "manual", outcome: "ok", conversations: 0 }]);
});

test("the summary states the counts", () => {
  const e = { conversations: 5, skipped: 2, notes: 4, refused: 0, errors: [] };
  const c = { ran: true, rewrites: 3, creates: 0, merges: [{ from: "a", into: "b" }], dropped: [{ pageId: "x", page: "X", line: "l1", reason: "r" }, { pageId: "x", page: "X", line: "l2", reason: "r" }] };
  assert.equal(summarize(e, c, "ok"), "5 conversations (2 trivial), 4 notes; 3 pages rewritten, 1 merge, 2 lines dropped");
  assert.equal(summarize({ ...e, conversations: 1, notes: 1, refused: 1 }, { ...c, rewrites: 1, creates: 2, merges: [], dropped: [] }, "ok"), "1 conversation (2 trivial), 1 note (1 refused); 1 page rewritten, 2 pages created, 0 merges, 0 lines dropped");
  assert.equal(summarize({ ...e, stopped: "model unavailable" }, undefined, "partial", "model unavailable"), "5 conversations (2 trivial), 4 notes; not consolidated [partial: model unavailable]");
  assert.ok(summarize(e, c, "partial", "x".repeat(600)).length <= 500);
});
