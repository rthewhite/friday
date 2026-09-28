import { test } from "node:test";
import assert from "node:assert/strict";
import { createContext, defineModule, nextCronRun, ToolRegistry, validateJob, validateManifest, type JobSpec, type ModuleJobs } from "../src/index.js";
import { createTestHost } from "../src/test.js";

const run = () => {};

test("validateJob accepts a cron job and an interval job", () => {
  validateJob("brain", { name: "nightly", cron: "0 3 * * *", run });
  validateJob("brain", { name: "poll", everyMs: 900_000, timeoutMs: 60_000, run });
});

test("validateJob rejects malformed declarations with an error naming the job", () => {
  const bad: [Partial<JobSpec> & Record<string, unknown>, RegExp][] = [
    [{ name: "Nightly", cron: "0 3 * * *" }, /job brain\/Nightly: name must be kebab-case/],
    [{ name: "", cron: "0 3 * * *" }, /name must be kebab-case/],
    [{ name: 42 as unknown as string, cron: "0 3 * * *" }, /job brain\/42: name must be kebab-case/],
    [{ name: "nightly", cron: "61 * * * *" }, /job brain\/nightly: invalid cron "61 \* \* \* \*"/],
    [{ name: "nightly", cron: "0 0 3 * * *" }, /job brain\/nightly: invalid cron/],
    [{ name: "nightly", cron: "0 3 * * *", everyMs: 60_000 }, /job brain\/nightly: declare exactly one of cron or everyMs/],
    [{ name: "nightly" }, /job brain\/nightly: declare exactly one of cron or everyMs/],
    [{ name: "poll", everyMs: 999 }, /job brain\/poll: everyMs must be at least 1000/],
    [{ name: "poll", everyMs: Number.NaN }, /everyMs must be at least 1000/],
    [{ name: "poll", everyMs: 1000, timeoutMs: 0 }, /job brain\/poll: timeoutMs must be a positive number/],
  ];
  for (const [spec, err] of bad) assert.throws(() => validateJob("brain", { run, ...spec } as JobSpec), err, JSON.stringify(spec));
  assert.throws(() => validateJob("brain", { name: "nightly", cron: "0 3 * * *" } as JobSpec), /job brain\/nightly: run must be a function/);
  assert.throws(() => validateJob("brain", { name: "nightly", cron: "0 3 * * *", run }, new Set(["nightly"])), /job brain\/nightly: a job with this name is already scheduled/);
});

test("nextCronRun follows the zone across daylight saving", () => {
  // 03:00 Amsterdam is 01:00Z in summer and 02:00Z in winter.
  assert.equal(nextCronRun("0 3 * * *", "Europe/Amsterdam", new Date("2026-07-01T12:00:00Z"))?.toISOString(), "2026-07-02T01:00:00.000Z");
  assert.equal(nextCronRun("0 3 * * *", "Europe/Amsterdam", new Date("2026-12-01T12:00:00Z"))?.toISOString(), "2026-12-02T02:00:00.000Z");
});

test("module id core is reserved", () => {
  assert.throws(() => validateManifest({ id: "core", label: "Core" }), /module id "core" is reserved/);
  validateManifest({ id: "core-tools", label: "Core tools" });
});

test("a host without a scheduler makes ctx.jobs.schedule throw", () => {
  const ctx = createContext({ id: "m", label: "M" }, { env: {}, registry: new ToolRegistry({ log() {}, warn() {}, error() {} }) });
  assert.throws(() => ctx.jobs.schedule({ name: "x", everyMs: 1000, run }), /^Error: m: jobs are not available in this host$/);
  assert.deepEqual(ctx.jobs.trigger("x"), { started: false });
});

// The README example, verbatim (packages/sdk/README.md, "ModuleContext" and "Testing a module").
const cleanup = defineModule({
  manifest: { id: "cleanup", label: "Cleanup" },
  init(ctx) {
    ctx.jobs.schedule({
      name: "nightly",
      description: "Deletes expired items",
      cron: "0 3 * * *",           // 03:00 in FRIDAY_TIMEZONE; or everyMs: 15 * 60_000
      timeoutMs: 10 * 60_000,      // optional: aborts the signal and records the run as failed
      async run({ signal, log, trigger }) {
        let deleted = 0;
        for (const item of ["a", "b"]) {
          if (signal.aborted) break;   // stop promptly on timeout, reload or shutdown
          deleted++;
        }
        log.log(`cleanup (${trigger}) done`);
        return { summary: `deleted ${deleted} items` };
      },
    });
  },
});

test("README example: the test host lists jobs and runs one directly", async () => {
  const h = await createTestHost(cleanup);
  assert.deepEqual(h.jobs, [{ name: "nightly", cron: "0 3 * * *" }]);
  assert.deepEqual(await h.runJob("nightly"), { outcome: "ok", summary: "deleted 2 items" });
});

test("test host: a throwing handler is failed with its message, and ctx.jobs.trigger respects overlap", async () => {
  let release!: () => void;
  let jobs!: ModuleJobs;
  const triggers: string[] = [];
  const m = defineModule({
    manifest: { id: "m", label: "M" },
    init(ctx) {
      jobs = ctx.jobs;
      ctx.jobs.schedule({ name: "boom", everyMs: 60_000, run: () => { throw new Error("jellyfin unreachable"); } });
      ctx.jobs.schedule({ name: "slow", everyMs: 60_000, run: ({ trigger }) => { triggers.push(trigger); return new Promise<void>((r) => (release = r)); } });
    },
  });
  const h = await createTestHost(m);
  assert.deepEqual(h.jobs, [{ name: "boom", everyMs: 60_000 }, { name: "slow", everyMs: 60_000 }]);
  assert.deepEqual(await h.runJob("boom"), { outcome: "failed", error: "jellyfin unreachable" });
  await assert.rejects(h.runJob("nope"), /job m\/nope is not scheduled/);
  assert.deepEqual(jobs.trigger("slow"), { started: true });
  assert.deepEqual(jobs.trigger("slow"), { started: false });
  release();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(jobs.trigger("slow"), { started: true });
  release();
  assert.deepEqual(triggers, ["module", "module"]);
});

test("test host rejects an invalid schedule with the host's error", async () => {
  const m = defineModule({ manifest: { id: "m", label: "M" }, init(ctx) { ctx.jobs.schedule({ name: "bad", cron: "61 * * * *", run }); } });
  await assert.rejects(createTestHost(m), /^Error: job m\/bad: invalid cron "61 \* \* \* \*"/);
  const dup = defineModule({ manifest: { id: "m", label: "M" }, init(ctx) { ctx.jobs.schedule({ name: "a", everyMs: 1000, run }); ctx.jobs.schedule({ name: "a", everyMs: 1000, run }); } });
  await assert.rejects(createTestHost(dup), /job m\/a: a job with this name is already scheduled/);
});
