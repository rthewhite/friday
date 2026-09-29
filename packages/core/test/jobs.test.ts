import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import type { JobContext, JobSpec, ModuleLogger } from "@friday/sdk";
import { migrate, migrations } from "../src/storage/db.js";
import { JobStore } from "../src/jobs/store.js";
import { MAX_TIMER_MS, Scheduler } from "../src/jobs/scheduler.js";
import { FakeClock } from "./fake-clock.js";

const quiet = { log() {} };

function logger() {
  const lines: string[] = [];
  const log: ModuleLogger = {
    log: (...a) => lines.push("log " + a.join(" ")),
    warn: (...a) => lines.push("warn " + a.join(" ")),
    error: (...a) => lines.push("error " + a.join(" ")),
  };
  return { lines, log };
}

function setup(start: string, opts: { db?: DatabaseSync; timezone?: string; history?: number; catchupDelayMs?: number; graceMs?: number } = {}) {
  const db = opts.db ?? new DatabaseSync(":memory:");
  if (!opts.db) migrate(db, migrations, quiet);
  const clock = new FakeClock(Date.parse(start));
  const store = new JobStore(db, opts.history ?? 50);
  const { lines, log } = logger();
  const s = new Scheduler({ store, clock, log, timezone: opts.timezone ?? "Europe/Amsterdam", catchupDelayMs: opts.catchupDelayMs ?? 30_000, graceMs: opts.graceMs ?? 10_000 });
  return { db, clock, store, s, lines, log };
}

const iso = (ms: number) => new Date(ms).toISOString();

/** Stop while a handler ignores its signal: the grace wait runs on the fake clock too. */
async function stopWithGrace(s: Scheduler, clock: FakeClock) {
  const p = s.stop();
  await clock.advance(10_000);
  await p;
}

// ---- store ----

test("store: runs are recorded, finished, newest first, and pruned to the history size", () => {
  const db = new DatabaseSync(":memory:");
  migrate(db, migrations, quiet);
  const store = new JobStore(db, 50);
  const t0 = Date.parse("2026-01-01T00:00:00Z");
  for (let i = 0; i < 50; i++) store.finishRun(store.startRun("a/x", "schedule", t0 + i * 1000), t0 + i * 1000 + 10, "ok");
  store.startRun("b/y", "manual", t0);
  assert.equal(store.runs("a/x", 1000).length, 50);
  const oldest = store.runs("a/x", 1000).at(-1)!;
  assert.equal(oldest.startedAt, iso(t0));
  const id = store.startRun("a/x", "manual", t0 + 50_000);
  const runs = store.runs("a/x", 1000);
  assert.equal(runs.length, 50, "the 51st run prunes the oldest");
  assert.equal(runs[0].id, id);
  assert.equal(runs[0].outcome, "running");
  assert.equal(runs[0].durationMs, null);
  assert.ok(!runs.some((r) => r.startedAt === iso(t0)));
  assert.equal(store.runs("b/y").length, 1, "other jobs are untouched");

  store.finishRun(id, t0 + 50_250, "failed", "s".repeat(600), "e".repeat(3000));
  const [last] = store.runs("a/x", 1);
  assert.equal(last.outcome, "failed");
  assert.equal(last.durationMs, 250);
  assert.equal(last.summary!.length, 500);
  assert.equal(last.error!.length, 2000);
  assert.equal(store.lastRun("a/x")!.id, id);

  const skipped = store.insertSkipped("a/x", "schedule", t0 + 60_000);
  assert.deepEqual(store.runs("a/x", 1)[0], { id: skipped, jobId: "a/x", trigger: "schedule", startedAt: iso(t0 + 60_000), finishedAt: iso(t0 + 60_000), durationMs: 0, outcome: "skipped" });
});

test("store: last_due_at round-trips and stale running rows are marked cancelled", () => {
  const db = new DatabaseSync(":memory:");
  migrate(db, migrations, quiet);
  const store = new JobStore(db);
  assert.equal(store.lastDue("a/x"), undefined);
  store.setLastDue("a/x", 1000);
  store.setLastDue("a/x", 2000);
  assert.equal(store.lastDue("a/x"), 2000);
  const id = store.startRun("a/x", "schedule", 1000);
  store.finishRun(store.startRun("a/y", "schedule", 1000), 1500, "ok");
  assert.equal(store.markInterrupted(5000), 1);
  const [r] = store.runs("a/x");
  assert.equal(r.id, id);
  assert.equal(r.outcome, "cancelled");
  assert.equal(r.error, "interrupted by restart");
  assert.equal(r.finishedAt, iso(5000));
  assert.equal(store.runs("a/y")[0].outcome, "ok");
});

// ---- scheduling ----

test("cron and interval jobs get their next due time, and interval jobs run every interval", async () => {
  const { clock, s, store } = setup("2026-09-28T12:00:00Z");
  const runs: string[] = [];
  s.register("brain", { name: "nightly", cron: "0 3 * * *", run: () => {} });
  s.register("media", { name: "poll", everyMs: 900_000, run: ({ trigger }) => void runs.push(`${iso(clock.now())} ${trigger}`) });
  const [nightly, poll] = s.list();
  assert.deepEqual(nightly.schedule, { cron: "0 3 * * *", timezone: "Europe/Amsterdam" });
  assert.equal(nightly.nextRunAt, "2026-09-29T01:00:00.000Z", "03:00 CEST");
  assert.deepEqual(poll.schedule, { everyMs: 900_000 });
  assert.equal(poll.nextRunAt, "2026-09-28T12:15:00.000Z");
  assert.equal(poll.lastRun, null);
  await clock.advance(31 * 60_000);
  assert.deepEqual(runs, ["2026-09-28T12:15:00.000Z schedule", "2026-09-28T12:30:00.000Z schedule"]);
  assert.equal(s.list()[1].nextRunAt, "2026-09-28T12:45:00.000Z");
  assert.equal(s.list()[1].lastRun?.outcome, "ok");
  assert.equal(store.lastDue("media/poll"), Date.parse("2026-09-28T12:30:00Z"));
  assert.throws(() => s.register("media", { name: "poll", everyMs: 1000, run: () => {} }), /job media\/poll: a job with this name is already scheduled/);
  assert.throws(() => s.register("media", { name: "bad", cron: "61 * * * *", run: () => {} }), /job media\/bad: invalid cron "61 \* \* \* \*"/);
  s.register("other", { name: "poll", everyMs: 1000, run: () => {} });
  await s.stop();
});

test("cron 0 3 * * * runs at 03:00 Amsterdam time across both DST transitions", async () => {
  const { clock, s } = setup("2026-03-27T12:00:00Z");
  const at: string[] = [];
  s.register("brain", { name: "nightly", cron: "0 3 * * *", run: () => void at.push(iso(clock.now())) });
  await clock.to("2026-03-31T00:00:00Z");
  assert.deepEqual(at, ["2026-03-28T02:00:00.000Z", "2026-03-29T01:00:00.000Z", "2026-03-30T01:00:00.000Z"]);
  at.length = 0;
  await clock.to("2026-10-27T00:00:00Z");
  assert.deepEqual(at.slice(-3), ["2026-10-24T01:00:00.000Z", "2026-10-25T02:00:00.000Z", "2026-10-26T02:00:00.000Z"]);
  await s.stop();
});

test("an invalid timezone logs an error and cron jobs run in Europe/Amsterdam, like the modules", async () => {
  const { s, lines } = setup("2026-09-28T12:00:00Z", { timezone: "Mars/Olympus" });
  assert.ok(lines.some((l) => l.startsWith("error") && l.includes('"Mars/Olympus"') && l.includes("Europe/Amsterdam")));
  s.register("brain", { name: "nightly", cron: "0 3 * * *", run: () => {} });
  assert.deepEqual(s.list()[0].schedule, { cron: "0 3 * * *", timezone: "Europe/Amsterdam" });
  // 03:00 summer time in Amsterdam is 01:00 UTC.
  assert.equal(s.list()[0].nextRunAt, "2026-09-29T01:00:00.000Z");
  await s.stop();
});

/** A scheduler whose zone comes from a reader the test can change, like core's store-backed one. */
function liveZone(start: string, zone: string | undefined = "Europe/Amsterdam") {
  const db = new DatabaseSync(":memory:");
  migrate(db, migrations, quiet);
  const clock = new FakeClock(Date.parse(start));
  const { lines, log } = logger();
  const cfg = { zone };
  const s = new Scheduler({ store: new JobStore(db, 50), clock, log, timezone: () => cfg.zone, catchupDelayMs: 30_000, graceMs: 1000 });
  return { s, clock, lines, cfg };
}

test("a changed zone re-plans cron jobs from now, and they run at the new local time", async () => {
  const { s, clock, lines, cfg } = liveZone("2026-09-28T12:00:00Z");
  const runs: string[] = [];
  s.register("brain", { name: "nightly", cron: "0 3 * * *", run: () => void runs.push(iso(clock.now())) });
  assert.equal(s.list()[0].nextRunAt, "2026-09-29T01:00:00.000Z", "03:00 Amsterdam");

  cfg.zone = "America/New_York";
  s.refreshTimezone();

  assert.deepEqual(s.list()[0].schedule, { cron: "0 3 * * *", timezone: "America/New_York" });
  assert.equal(s.list()[0].nextRunAt, "2026-09-29T07:00:00.000Z", "03:00 New York");
  assert.ok(lines.some((l) => l.includes("timezone changed to America/New_York; 1 cron job(s) re-planned")));
  await clock.to("2026-09-29T06:59:00Z");
  assert.deepEqual(runs, [], "the old Amsterdam slot is gone");
  await clock.to("2026-09-29T07:00:00Z");
  assert.deepEqual(runs, ["2026-09-29T07:00:00.000Z"]);
  await s.stop();
});

test("refreshing with the zone unchanged re-plans nothing", async () => {
  const { s, clock, lines } = liveZone("2026-09-28T12:00:00Z");
  s.register("brain", { name: "nightly", cron: "0 3 * * *", run: () => {} });
  const timers = [...clock.timers.keys()];
  s.refreshTimezone();
  assert.deepEqual([...clock.timers.keys()], timers);
  assert.ok(!lines.some((l) => l.includes("re-planned")));
  await s.stop();
});

test("a zone change leaves interval jobs on their schedule", async () => {
  const { s, cfg } = liveZone("2026-09-28T12:00:00Z");
  s.register("media", { name: "poll", everyMs: 900_000, run: () => {} });
  cfg.zone = "Asia/Tokyo";
  s.refreshTimezone();
  assert.equal(s.list()[0].nextRunAt, "2026-09-28T12:15:00.000Z");
  await s.stop();
});

test("an invalid zone saved while running falls back to Amsterdam and logs one error", async () => {
  const { s, lines, cfg } = liveZone("2026-09-28T12:00:00Z", "America/New_York");
  s.register("brain", { name: "nightly", cron: "0 3 * * *", run: () => {} });
  cfg.zone = "Mars/Olympus";
  s.refreshTimezone();
  s.refreshTimezone();
  assert.equal(s.timezone, "Europe/Amsterdam");
  assert.equal(s.list()[0].nextRunAt, "2026-09-29T01:00:00.000Z");
  assert.equal(lines.filter((l) => l.startsWith("error") && l.includes('"Mars/Olympus"')).length, 1);
  await s.stop();
});

test("a zone change does not cancel a run in progress", async () => {
  const { s, clock, cfg } = liveZone("2026-09-29T00:59:00Z");
  s.register("brain", { name: "nightly", cron: "0 3 * * *", run: () => clock.sleep(10 * 60_000).then(() => ({ summary: "done" })) });
  await clock.to("2026-09-29T01:01:00Z");
  assert.equal(s.list()[0].running, true);
  cfg.zone = "America/New_York";
  s.refreshTimezone();
  await clock.to("2026-09-29T01:15:00Z");
  assert.equal(s.list()[0].lastRun?.outcome, "ok");
  assert.equal(s.list()[0].nextRunAt, "2026-09-29T07:00:00.000Z");
  await s.stop();
});

test("an unset or blank timezone means Europe/Amsterdam, without an error", async () => {
  for (const timezone of [undefined, "", "  "]) {
    const db = new DatabaseSync(":memory:");
    migrate(db, migrations, quiet);
    const { lines, log } = logger();
    const s = new Scheduler({ store: new JobStore(db, 50), clock: new FakeClock(Date.parse("2026-09-28T12:00:00Z")), log, timezone });
    s.register("brain", { name: "nightly", cron: "0 3 * * *", run: () => {} });
    assert.deepEqual(s.list()[0].schedule, { cron: "0 3 * * *", timezone: "Europe/Amsterdam" }, `timezone ${JSON.stringify(timezone)}`);
    assert.ok(!lines.some((l) => l.startsWith("error")));
    await s.stop();
  }
});

test("very long waits are capped at 2^31-1 ms and re-armed", async () => {
  const { clock, s } = setup("2026-01-01T00:00:00Z", { timezone: "UTC" });
  let runs = 0;
  s.register("core", { name: "yearly", cron: "0 0 1 7 *", run: () => void runs++ });
  assert.ok([...clock.timers.values()].every((t) => t.at - clock.t <= MAX_TIMER_MS));
  await clock.to("2026-06-30T23:59:00Z");
  assert.equal(runs, 0);
  await clock.to("2026-07-01T00:00:01Z");
  assert.equal(runs, 1);
  await s.stop();
});

test("a job never overlaps itself: due times during a slow run are skipped; other jobs run", async () => {
  const { clock, s, store } = setup("2026-09-28T12:00:00Z");
  let started = 0, concurrent = 0, maxConcurrent = 0, quick = 0;
  s.register("a", { name: "slow", everyMs: 60_000, run: async () => {
    started++; concurrent++; maxConcurrent = Math.max(maxConcurrent, concurrent);
    await clock.sleep(150_000);
    concurrent--;
  } });
  s.register("b", { name: "quick", everyMs: 30_000, run: () => void quick++ });
  await clock.advance(60_000); // slow starts at +60 s, runs until +210 s
  assert.equal(s.list()[0].running, true);
  assert.equal(s.list()[0].runningSince, "2026-09-28T12:01:00.000Z");
  await clock.advance(150_000); // +120 s and +180 s come due during the run
  const runs = store.runs("a/slow");
  assert.deepEqual(runs.map((r) => [r.outcome, r.startedAt]), [["skipped", "2026-09-28T12:03:00.000Z"], ["skipped", "2026-09-28T12:02:00.000Z"], ["ok", "2026-09-28T12:01:00.000Z"]]);
  assert.equal(started, 1);
  assert.equal(maxConcurrent, 1);
  assert.equal(quick, 7, "b/quick keeps running while a/slow is busy");
  assert.equal(s.list()[0].lastRun?.outcome, "ok", "last run is the finished one, not a skip recorded during it");
  await clock.advance(30_000); // +240 s: runs again
  assert.equal(started, 2);
  await stopWithGrace(s, clock);
});

test("on-demand runs follow the no-overlap rule and do not move the schedule", async () => {
  const { clock, s, store } = setup("2026-09-28T12:00:00Z");
  const triggers: string[] = [];
  s.register("brain", { name: "nightly", cron: "0 3 * * *", run: async ({ trigger }) => { triggers.push(trigger); await clock.sleep(1000); } });
  const before = s.list()[0].nextRunAt;
  const lastDue = store.lastDue("brain/nightly");
  const r = s.runNow("brain/nightly");
  assert.equal(r.status, "started");
  assert.deepEqual(s.runNow("brain/nightly"), { status: "running" });
  assert.deepEqual(s.forOwner("brain").trigger("nightly"), { started: false });
  assert.deepEqual(s.runNow("brain/nope"), { status: "unknown" });
  assert.throws(() => s.forOwner("brain").trigger("nope"), /job brain\/nope is not scheduled/);
  await clock.advance(1000);
  assert.deepEqual(s.forOwner("brain").trigger("nightly"), { started: true });
  await clock.advance(1000);
  assert.deepEqual(triggers, ["manual", "module"]);
  assert.equal(s.list()[0].nextRunAt, before);
  assert.equal(store.lastDue("brain/nightly"), lastDue);
  assert.deepEqual(store.runs("brain/nightly").map((x) => [x.trigger, x.outcome]), [["module", "ok"], ["manual", "ok"]]);
  await s.stop();
});

test("summaries are recorded and each run logs its start and end with the job id", async () => {
  const { clock, s, store, lines } = setup("2026-09-28T12:00:00Z");
  let seen: JobContext | undefined;
  s.register("brain", { name: "tidy", everyMs: 1000, run: (job) => { seen = job; job.log.log("working"); return { summary: "deleted 12 conversations" }; } });
  await clock.advance(1000);
  const [r] = store.runs("brain/tidy");
  assert.equal(r.outcome, "ok");
  assert.equal(r.summary, "deleted 12 conversations");
  assert.equal(r.durationMs, 0);
  assert.equal(seen?.trigger, "schedule");
  assert.ok(seen?.signal instanceof AbortSignal);
  assert.deepEqual(lines, ["log job brain/tidy: started (schedule)", "log [brain] working", "log job brain/tidy: ok in 0 ms: deleted 12 conversations"]);
  await s.stop();
});

// ---- catch-up ----

test("catch-up: down over the nightly slot runs once after the delay, then on schedule", async () => {
  const db = new DatabaseSync(":memory:");
  migrate(db, migrations, quiet);
  const first = setup("2026-09-27T12:00:00Z", { db });
  first.s.register("brain", { name: "nightly", cron: "0 3 * * *", run: () => {} });
  await first.clock.to("2026-09-29T00:00:00Z"); // 02:00 CEST; the 28th's 03:00 run happened
  await first.s.stop();
  assert.equal(first.store.runs("brain/nightly").length, 1);

  // Down from 02:00 until 04:00 local time, missing the 29th's 03:00 slot.
  const again = setup("2026-09-29T02:00:00Z", { db });
  const triggers: string[] = [];
  again.s.register("brain", { name: "nightly", cron: "0 3 * * *", run: ({ trigger }) => void triggers.push(`${iso(again.clock.now())} ${trigger}`) });
  assert.equal(again.s.list()[0].nextRunAt, "2026-09-30T01:00:00.000Z");
  await again.clock.advance(29_000);
  assert.deepEqual(triggers, []);
  await again.clock.advance(1000);
  assert.deepEqual(triggers, ["2026-09-29T02:00:30.000Z catch-up"]);
  assert.equal(again.store.lastDue("brain/nightly"), Date.parse("2026-09-29T01:00:00Z"), "last_due_at is the missed due time");
  await again.clock.to("2026-09-30T02:00:00Z");
  assert.deepEqual(triggers, ["2026-09-29T02:00:30.000Z catch-up", "2026-09-30T01:00:00.000Z schedule"]);
  await again.s.stop();
});

test("catch-up: down for three days runs once, not three times", async () => {
  const db = new DatabaseSync(":memory:");
  migrate(db, migrations, quiet);
  new JobStore(db).setLastDue("brain/nightly", Date.parse("2026-09-25T01:00:00Z"));
  const { clock, s, store } = setup("2026-09-28T12:00:00Z", { db });
  let runs = 0;
  s.register("brain", { name: "nightly", cron: "0 3 * * *", run: () => void runs++ });
  await clock.advance(60_000);
  assert.equal(runs, 1);
  assert.equal(store.runs("brain/nightly")[0].trigger, "catch-up");
  assert.equal(store.lastDue("brain/nightly"), Date.parse("2026-09-28T01:00:00Z"));
  assert.equal(s.list()[0].nextRunAt, "2026-09-29T01:00:00.000Z");
  await s.stop();
});

test("catch-up: interval jobs catch up once too; a new job is not caught up", async () => {
  const db = new DatabaseSync(":memory:");
  migrate(db, migrations, quiet);
  new JobStore(db).setLastDue("m/poll", Date.parse("2026-09-28T10:00:00Z"));
  const { clock, s, store } = setup("2026-09-28T12:00:00Z", { db, catchupDelayMs: 5000 });
  const seen: string[] = [];
  s.register("m", { name: "poll", everyMs: 3_600_000, run: ({ trigger }) => void seen.push(`poll ${trigger}`) });
  s.register("m", { name: "fresh", cron: "* * * * *", run: ({ trigger }) => void seen.push(`fresh ${trigger}`) });
  assert.equal(store.lastDue("m/fresh"), clock.now(), "a new job records now");
  assert.equal(s.list().find((j) => j.name === "poll")!.nextRunAt, "2026-09-28T13:00:00.000Z");
  await clock.advance(5000);
  assert.deepEqual(seen, ["poll catch-up"]);
  await clock.advance(55_000);
  assert.deepEqual(seen, ["poll catch-up", "fresh schedule"]);
  await s.stop();
});

// ---- failures and cancellation ----

test("a throwing handler is failed with its message and the job runs again at its next due time", async () => {
  const { clock, s, store, lines } = setup("2026-09-28T12:00:00Z");
  let n = 0;
  s.register("media", { name: "sync", everyMs: 60_000, run: () => { n++; throw new Error("jellyfin unreachable"); } });
  s.register("media", { name: "async", everyMs: 60_000, run: async () => { throw new Error("later"); } });
  await clock.advance(120_000);
  assert.equal(n, 2);
  assert.deepEqual(store.runs("media/sync").map((r) => [r.outcome, r.error]), [["failed", "jellyfin unreachable"], ["failed", "jellyfin unreachable"]]);
  assert.equal(store.runs("media/async")[0].error, "later");
  assert.ok(lines.includes("error job media/sync: failed in 0 ms: jellyfin unreachable"));
  await s.stop();
});

test("timeout aborts the signal and records failed with a timeout message", async () => {
  const { clock, s, store } = setup("2026-09-28T12:00:00Z");
  let aborted = false;
  s.register("brain", { name: "long", everyMs: 3_600_000, timeoutMs: 60_000, run: async ({ signal }) => {
    await clock.sleep(120_000, signal).catch(() => { aborted = true; });
  } });
  s.register("brain", { name: "stubborn", everyMs: 3_600_000, timeoutMs: 60_000, run: async () => { await clock.sleep(120_000); } });
  await clock.advance(3_600_000 + 60_000);
  assert.equal(aborted, true);
  assert.deepEqual(store.runs("brain/long").map((r) => [r.outcome, r.error, r.durationMs]), [["failed", "timed out after 60000 ms", 60_000]]);
  assert.equal(store.runs("brain/stubborn")[0].outcome, "running", "a handler that ignores its signal stays running");
  await clock.advance(60_000);
  assert.deepEqual(store.runs("brain/stubborn").map((r) => [r.outcome, r.error, r.durationMs]), [["failed", "timed out after 60000 ms", 120_000]], "resolving after a timeout is still failed");
  await s.stop();
});

test("stop during a run aborts the signal and records cancelled", async () => {
  const { clock, s, store } = setup("2026-09-28T12:00:00Z");
  let reason: unknown;
  s.register("brain", { name: "nightly", everyMs: 60_000, run: ({ signal }) => clock.sleep(600_000, signal).catch((e) => { reason = e; throw e; }) });
  await clock.advance(60_000);
  await s.stop();
  assert.match(String(reason), /cancelled: Friday is shutting down/);
  const [r] = store.runs("brain/nightly");
  assert.equal(r.outcome, "cancelled");
  assert.equal(r.error, "cancelled: Friday is shutting down");
  assert.deepEqual(s.list(), []);
  assert.equal(clock.timers.size, 0, "no timers left after stop");
});

test("a handler that ignores its signal is waited for up to the grace period and never overlapped", async () => {
  const { clock, s, store, lines } = setup("2026-09-28T12:00:00Z", { graceMs: 10_000 });
  let started = 0;
  const spec: JobSpec = { name: "deaf", everyMs: 60_000, run: async () => { started++; await clock.sleep(300_000); } };
  s.register("m", spec);
  await clock.advance(60_000);
  let removed = false;
  const p = s.removeOwner("m").then(() => (removed = true));
  await clock.advance(9_000);
  assert.equal(removed, false, "waits for the run to settle");
  await clock.advance(1_000);
  await p;
  assert.ok(lines.some((l) => l.startsWith("warn job m/deaf: still running 10000 ms after it was cancelled")));
  // Re-registered (as on reload) while the old handler is still going: no second run starts.
  s.register("m", spec);
  assert.deepEqual(s.runNow("m/deaf"), { status: "running" });
  assert.equal(s.list()[0].running, true);
  await clock.advance(60_000);
  assert.equal(started, 1);
  assert.equal(store.runs("m/deaf").filter((r) => r.outcome === "skipped").length, 1);
  await clock.advance(300_000);
  assert.deepEqual(store.runs("m/deaf").map((r) => [r.outcome, r.startedAt]).at(-1), ["cancelled", "2026-09-28T12:01:00.000Z"], "recorded as cancelled once it finally settled");
  assert.ok(started >= 2, "runs again once the old handler settled");
  await stopWithGrace(s, clock);
});

test("removeOwner only affects that owner's jobs", async () => {
  const { clock, s } = setup("2026-09-28T12:00:00Z");
  let a = 0, b = 0;
  s.register("a", { name: "x", everyMs: 1000, run: () => void a++ });
  s.register("b", { name: "x", everyMs: 1000, run: () => void b++ });
  await clock.advance(1000);
  await s.removeOwner("a");
  await clock.advance(2000);
  assert.deepEqual([a, b], [1, 3]);
  assert.deepEqual(s.list().map((j) => j.id), ["b/x"]);
  await s.stop();
});

test("settings defaults for jobs", async () => {
  for (const k of ["FRIDAY_JOB_HISTORY", "FRIDAY_JOB_CATCHUP_DELAY_MS"]) delete process.env[k];
  const { settings } = await import("../src/config.js");
  assert.equal(settings.jobHistory, 50);
  assert.equal(settings.jobCatchupDelayMs, 30_000);
  // FRIDAY_TIMEZONE is not a startup setting: the scheduler reads it through core's config resolver.
  assert.ok(!("timezone" in settings));
});
