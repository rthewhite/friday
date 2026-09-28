import { test } from "node:test";
import assert from "node:assert/strict";
import { registerRetention, retentionJob } from "../src/conversations/retention.js";
import { JobStore } from "../src/jobs/store.js";
import { Scheduler } from "../src/jobs/scheduler.js";
import { FakeClock } from "./fake-clock.js";
import { setup } from "./conversation-fixtures.js";

const DAY = 86_400_000;
const run = (job: ReturnType<typeof retentionJob>, signal = new AbortController().signal) =>
  job.run({ signal, log: { log() {}, warn() {}, error() {} }, trigger: "schedule" });

test("retention deletes conversations inactive beyond the period and keeps a recently resumed thread", async () => {
  const { store, clock } = setup();
  const thread = store.create({ channel: "chat" }); // started 120 days before the run
  store.append(thread, 1, { kind: "user", at: store.now().toISOString(), input: "text", text: "hi" });
  clock.advance(29 * DAY);
  const old = store.create({ channel: "voice", device: "kitchen" }); // last activity 91 days before the run
  store.append(old, 1, { kind: "user", at: store.now().toISOString(), input: "speech", text: "lights on" });
  clock.advance(81 * DAY);
  store.append(thread, 2, { kind: "user", at: store.now().toISOString(), input: "text", text: "back again" }); // resumed 10 days before
  clock.advance(10 * DAY);

  const job = retentionJob(store, 90);
  assert.equal(job.cron, "0 4 * * *");
  assert.deepEqual(await run(job), { summary: "deleted 1 conversation" });
  assert.equal(store.get(old), undefined);
  assert.equal(store.get(thread)?.entries.length, 2);
  assert.deepEqual(await run(job), { summary: "deleted 0 conversations" });
});

test("retention deletes in batches until nothing is left, and stops when aborted", async () => {
  const { db, store, clock } = setup();
  const remaining = () => (db.prepare("SELECT COUNT(*) AS n FROM conversations").get() as { n: number }).n;
  for (let i = 0; i < 1200; i++) store.append(store.create({ channel: "voice" }), 1, { kind: "user", at: store.now().toISOString(), input: "speech", text: `q${i}` });
  clock.advance(100 * DAY);
  assert.deepEqual(await run(retentionJob(store, 90)), { summary: "deleted 1200 conversations" });

  for (let i = 0; i < 1200; i++) store.append(store.create({ channel: "voice" }), 1, { kind: "user", at: store.now().toISOString(), input: "speech", text: `q${i}` });
  clock.advance(100 * DAY);
  const ac = new AbortController();
  const pending = run(retentionJob(store, 90), ac.signal); // the first batch is deleted before the run yields
  ac.abort();
  assert.deepEqual(await pending, { summary: "deleted 500 conversations" });
  assert.equal(remaining(), 700);
});

test("retention registers core/conversation-retention, and nothing when disabled with 0", async () => {
  const { db, store } = setup();
  const scheduler = new Scheduler({ store: new JobStore(db, 50), timezone: "Europe/Amsterdam", clock: new FakeClock(Date.parse("2026-10-01T10:00:00Z")), log: { log() {}, warn() {}, error() {} } });
  assert.equal(registerRetention(scheduler, store, 0), false);
  assert.deepEqual(scheduler.list(), []);
  assert.equal(registerRetention(scheduler, store, 90), true);
  const [job] = scheduler.list();
  assert.equal(job.id, "core/conversation-retention");
  assert.deepEqual(job.schedule, { cron: "0 4 * * *", timezone: "Europe/Amsterdam" });
  await scheduler.stop();
});
