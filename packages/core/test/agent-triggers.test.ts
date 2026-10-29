import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAgent } from "../src/agents/definition.js";
import { AgentTriggers } from "../src/agents/triggers.js";
import { Scheduler } from "../src/jobs/scheduler.js";
import { JobStore } from "../src/jobs/store.js";
import { agentHarness, quiet } from "./agent-harness.js";
import { FakeClock } from "./fake-clock.js";
import { waitFor } from "./helpers.js";
import type { Round } from "./fake-stream.js";

const JOB = "core/agent-weekly-review";
/** Waits until the agent has a run and none of its runs is still going. */
const finished = (t: { runs: { list(name: string): { outcome: string }[] } }, name = "weekly-review") =>
  waitFor(() => t.runs.list(name).length > 0 && t.runs.list(name).every((r) => r.outcome !== "running"));
/** A run is recorded the moment it starts, so after the scheduler's timers have fired there is nothing left to wait for. */
const fired = (t: { clock: FakeClock }) => t.clock.advance(0);

/** Agents with real scheduling on a fake clock starting on Sunday 25 October 2026, 12:00 UTC (13:00 in Amsterdam). */
function setup(rounds: Round[] = [{ chunks: [{ kind: "text", text: "Busy week.", part: { text: "Busy week." } }] }], start = "2026-10-25T12:00:00Z") {
  const t = agentHarness(rounds);
  const clock = new FakeClock(Date.parse(start));
  const jobs = new JobStore(t.db);
  const scheduler = new Scheduler({ store: jobs, clock, log: quiet, timezone: "Europe/Amsterdam" });
  const triggers = new AgentTriggers({ agents: t.agents, runtime: t.runtime, registry: t.registry, scheduler, jobs, timezone: () => "Europe/Amsterdam", log: quiet });
  return { ...t, clock, jobs, scheduler, triggers };
}

const weekly = { schedule: "0 18 * * 0" };

test("an enabled agent with a schedule runs at its due time as core job agent-<name>", async () => {
  const t = setup();
  t.define(weekly);
  t.triggers.start();
  const [job] = t.scheduler.list();
  assert.deepEqual([job.id, job.description, job.nextRunAt], [JOB, "A scheduled agent run", "2026-10-25T17:00:00.000Z"]);

  await t.clock.to("2026-10-25T17:00:00Z");
  await finished(t);
  const [run] = t.runs.list("weekly-review");
  assert.deepEqual([run.trigger, run.outcome, run.summary], ["schedule", "ok", "Busy week."]);
  await t.clock.advance(0);
  assert.deepEqual(t.jobs.runs(JOB).map((r) => [r.trigger, r.outcome, r.summary]), [["schedule", "ok", "ok"]], "the job records the outcome, never the answer");
  await t.scheduler.stop();
});

test("a disabled agent is not scheduled, and an agent without a schedule has no job", async () => {
  const t = setup();
  t.define(weekly);
  t.agents.create(parseAgent({ name: "on-demand", description: "Only by hand", instructions: "Do it." }));
  t.triggers.start();
  assert.deepEqual(t.scheduler.list().map((j) => j.id), [JOB]);
  t.agents.update(parseAgent({ name: "weekly-review", description: "Sums up my week", instructions: "x", ...weekly, enabled: false }));
  assert.deepEqual(t.scheduler.list(), []);
  await t.clock.to("2026-10-25T18:00:00Z");
  await fired(t);
  assert.deepEqual(t.runs.list("weekly-review"), []);
  await t.scheduler.stop();
});

test("changing the schedule never causes a catch-up run for the old schedule's last due time", async () => {
  // Tuesday: the weekly run happened on Sunday. Becoming daily at 07:00 must not run Monday's or Tuesday's slot now.
  const t = setup(undefined, "2026-10-27T12:00:00Z");
  t.define(weekly);
  t.jobs.setLastDue(JOB, Date.parse("2026-10-25T17:00:00Z"));
  t.triggers.start();
  t.agents.update(parseAgent({ name: "weekly-review", description: "Sums up my week", instructions: "x", schedule: "0 7 * * *" }));
  await t.clock.advance(60_000);
  await fired(t);
  assert.deepEqual(t.runs.list("weekly-review"), []);
  assert.equal(t.scheduler.list()[0].nextRunAt, "2026-10-28T06:00:00.000Z");
  await t.scheduler.stop();
});

test("a run missed while Friday was down catches up once after the restart", async () => {
  // Down over Sunday 18:00 (17:00 UTC); back at 19:00 UTC.
  const t = setup(undefined, "2026-10-25T19:00:00Z");
  t.define(weekly);
  t.jobs.setLastDue(JOB, Date.parse("2026-10-18T17:00:00Z"));
  t.triggers.start();
  await t.clock.advance(30_000);
  await finished(t);
  assert.deepEqual(t.runs.list("weekly-review").map((r) => r.trigger), ["schedule"]);
  await t.clock.advance(0);
  assert.equal(t.jobs.runs(JOB)[0].trigger, "catch-up");
  await t.scheduler.stop();
});

test("enabling an agent again does not catch up a slot missed while it was disabled", async () => {
  const t = setup(undefined, "2026-10-25T12:00:00Z");
  t.define(weekly);
  t.triggers.start();
  const disabled = { name: "weekly-review", description: "Sums up my week", instructions: "x", ...weekly };
  t.agents.update(parseAgent({ ...disabled, enabled: false }));
  await t.clock.to("2026-10-26T12:00:00Z");
  t.agents.update(parseAgent(disabled));
  await t.clock.advance(60_000);
  await fired(t);
  assert.deepEqual(t.runs.list("weekly-review"), []);
  assert.equal(t.scheduler.list()[0].nextRunAt, "2026-11-01T17:00:00.000Z");
  await t.scheduler.stop();
});

test("a due time while the agent runs from elsewhere records 'already running since'", async () => {
  const t = setup([{ waitMs: 50, chunks: [] }]);
  t.define(weekly);
  t.triggers.start();
  const manual = t.runtime.start("weekly-review", "voice");
  assert.ok(manual.ok);
  await t.clock.to("2026-10-25T17:00:00Z");
  await t.clock.advance(0);
  // The harness clock started the voice run on 1 October at 10:00 UTC, 12:00 in Amsterdam (summer time).
  assert.deepEqual(t.jobs.runs(JOB).map((r) => [r.outcome, r.summary]), [["ok", "already running since 12:00"]]);
  await manual.done;
  await t.scheduler.stop();
});

test("Run now on the Jobs page starts a portal run; deleting the agent removes its job and job history", async () => {
  const t = setup();
  t.define(weekly);
  t.triggers.start();
  assert.equal(t.scheduler.runNow(JOB).status, "started");
  await finished(t);
  assert.equal(t.runs.list("weekly-review")[0].trigger, "portal");
  await t.clock.advance(0);
  assert.equal(t.jobs.runs(JOB).length, 1);

  t.agents.delete("weekly-review");
  assert.deepEqual(t.scheduler.list(), []);
  assert.deepEqual(t.jobs.runs(JOB), []);
  assert.equal(t.jobs.lastDue(JOB), undefined);
  await t.scheduler.stop();
});

test("a failed agent run fails the job run with only its outcome; aborting the job cancels the agent run", async () => {
  const t = setup([{ error: new Error("boom") }]);
  t.define(weekly);
  t.triggers.start();
  t.scheduler.runNow(JOB);
  await finished(t);
  await t.clock.advance(0);
  assert.deepEqual(t.jobs.runs(JOB).map((r) => [r.outcome, r.error]), [["failed", "failed"]]);
  assert.equal(t.runs.list("weekly-review")[0].error, "unavailable: boom", "the error is the creator's to read, on the run");

  const slow = setup([{ waitMs: Infinity }]);
  slow.define(weekly);
  slow.triggers.start();
  slow.scheduler.runNow(JOB);
  await waitFor(() => slow.runs.list("weekly-review").length === 1);
  await slow.scheduler.stop();
  await finished(slow);
  assert.equal(slow.runs.list("weekly-review")[0].outcome, "cancelled");
});
