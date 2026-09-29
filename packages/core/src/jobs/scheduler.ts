/**
 * Core's job scheduler: one timer per job, a no-overlap guard, one catch-up run after downtime,
 * cancellation, and a record of every run. The clock and timers are injected for tests.
 */
import { DEFAULT_TIME_ZONE, nextCronRun, prefixedLogger, resolveTimeZone, validateJob, type JobOutcome, type JobSpec, type JobTrigger, type ModuleJobs, type ModuleLogger } from "@friday/sdk";
import type { JobRunRecord, JobStore } from "./store.js";

/** Node timers overflow beyond this; longer waits are re-armed on expiry. */
export const MAX_TIMER_MS = 2 ** 31 - 1;

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** Real time. Timers are unref'd: the HTTP server keeps the process alive, jobs alone never do. */
export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms).unref(),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export interface SchedulerOptions {
  store: JobStore;
  /** IANA zone for cron expressions (FRIDAY_TIMEZONE, raw). Unset or blank means Europe/Amsterdam; invalid logs an error and falls back to it, as modules do. */
  timezone?: string;
  /** Wait this long after registration before a catch-up run (FRIDAY_JOB_CATCHUP_DELAY_MS). */
  catchupDelayMs?: number;
  /** How long removeOwner/stop wait for aborted runs to settle. */
  graceMs?: number;
  log?: ModuleLogger;
  clock?: Clock;
}

/** `ctx.jobs` for one owner, plus the teardown hook ModuleHost calls on dispose, reload and failed init. */
export interface OwnerJobs extends ModuleJobs {
  /** Unregister the owner's jobs, abort its in-flight runs, and wait (up to the grace period) for them to settle. */
  removeAll(): Promise<void>;
}

export type JobSchedule = { cron: string; timezone: string } | { everyMs: number };

/** One entry of GET /api/jobs. */
export interface JobInfo {
  id: string;
  owner: string;
  name: string;
  description?: string;
  schedule: JobSchedule;
  nextRunAt: string | null;
  running: boolean;
  runningSince?: string;
  lastRun: JobRunRecord | null;
}

export type RunNowResult = { status: "started"; runId: string } | { status: "running" } | { status: "unknown" };

interface Job {
  id: string;
  owner: string;
  spec: JobSpec;
  nextDue: number | null;
  timer?: unknown;
  catchup?: unknown;
}

interface Run {
  jobId: string;
  runId: string;
  startedAt: number;
  controller: AbortController;
  /** Why the signal was aborted; decides the outcome once the handler settles. */
  reason?: { kind: "timeout" | "cancelled"; message: string };
  done: Promise<void>;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export class Scheduler {
  readonly timezone: string;
  private readonly jobs = new Map<string, Job>();
  /** In-flight runs by job id. Outlives unregistration so a re-registered job cannot overlap a run that ignored its signal. */
  private readonly active = new Map<string, Run>();
  private readonly store: JobStore;
  private readonly clock: Clock;
  private readonly log: ModuleLogger;
  private readonly catchupDelayMs: number;
  private readonly graceMs: number;

  constructor(opts: SchedulerOptions) {
    this.store = opts.store;
    this.clock = opts.clock ?? systemClock;
    this.log = opts.log ?? console;
    this.catchupDelayMs = opts.catchupDelayMs ?? 30_000;
    this.graceMs = opts.graceMs ?? 10_000;
    const { zone, valid } = resolveTimeZone(opts.timezone);
    if (!valid) this.log.error(`jobs: invalid timezone "${opts.timezone}" (FRIDAY_TIMEZONE); cron jobs are scheduled in ${DEFAULT_TIME_ZONE}`);
    this.timezone = zone;
  }

  forOwner(owner: string): OwnerJobs {
    return {
      schedule: (spec) => this.register(owner, spec),
      trigger: (name) => {
        const r = this.runNow(`${owner}/${name}`, "module");
        if (r.status === "unknown") throw new Error(`job ${owner}/${name} is not scheduled`);
        return { started: r.status === "started" };
      },
      removeAll: () => this.removeOwner(owner),
    };
  }

  /** Validate and schedule a job. A missed due time since the last scheduled run queues one catch-up run. */
  register(owner: string, spec: JobSpec): void {
    const taken = new Set([...this.jobs.values()].filter((j) => j.owner === owner).map((j) => j.spec.name));
    validateJob(owner, spec, taken);
    const job: Job = { id: `${owner}/${spec.name}`, owner, spec, nextDue: null };
    this.jobs.set(job.id, job);
    const now = this.clock.now();
    const last = this.store.lastDue(job.id);
    if (last === undefined) {
      this.store.setLastDue(job.id, now);
      job.nextDue = this.next(job, now);
    } else {
      const next = this.next(job, last);
      if (next !== null && next <= now) {
        const missed = this.latestDue(job, next, now);
        job.nextDue = this.next(job, missed);
        job.catchup = this.clock.setTimeout(() => this.catchUp(job, missed), this.catchupDelayMs);
      } else {
        job.nextDue = next;
      }
    }
    this.arm(job);
  }

  /** Start a job outside its schedule. Never changes when the next scheduled run is due. */
  runNow(jobId: string, trigger: Extract<JobTrigger, "manual" | "module"> = "manual"): RunNowResult {
    const job = this.jobs.get(jobId);
    if (!job) return { status: "unknown" };
    if (this.active.has(jobId)) return { status: "running" };
    return { status: "started", runId: this.start(job, trigger) };
  }

  /** Unregister an owner's jobs and cancel their in-flight runs, waiting up to the grace period. */
  async removeOwner(owner: string): Promise<void> {
    await this.cancel([...this.jobs.values()].filter((j) => j.owner === owner), `${owner} was unloaded`);
  }

  /** Shutdown: every job is unregistered and every in-flight run cancelled. */
  async stop(): Promise<void> {
    await this.cancel([...this.jobs.values()], "Friday is shutting down");
  }

  has(jobId: string): boolean {
    return this.jobs.has(jobId);
  }

  list(): JobInfo[] {
    return [...this.jobs.values()]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((j) => {
        const run = this.active.get(j.id);
        return {
          id: j.id,
          owner: j.owner,
          name: j.spec.name,
          ...(j.spec.description ? { description: j.spec.description } : {}),
          schedule: j.spec.cron !== undefined ? { cron: j.spec.cron, timezone: this.timezone } : { everyMs: j.spec.everyMs! },
          nextRunAt: j.nextDue === null ? null : new Date(j.nextDue).toISOString(),
          running: run !== undefined,
          ...(run ? { runningSince: new Date(run.startedAt).toISOString() } : {}),
          lastRun: this.store.lastRun(j.id) ?? null,
        };
      });
  }

  /** Recorded runs of a registered job, newest first; undefined for unknown jobs. */
  runs(jobId: string): JobRunRecord[] | undefined {
    return this.jobs.has(jobId) ? this.store.runs(jobId) : undefined;
  }

  private next(job: Job, from: number): number | null {
    if (job.spec.everyMs !== undefined) return from + job.spec.everyMs;
    return nextCronRun(job.spec.cron!, this.timezone, new Date(from))?.getTime() ?? null;
  }

  /** The most recent due time at or before `now`, starting from the first missed one. */
  private latestDue(job: Job, first: number, now: number): number {
    const every = job.spec.everyMs;
    if (every !== undefined) return first + Math.floor((now - first) / every) * every;
    let due = first;
    for (let n = this.next(job, due); n !== null && n <= now; n = this.next(job, due)) due = n;
    return due;
  }

  private arm(job: Job): void {
    if (job.nextDue === null) return;
    const delay = Math.max(0, Math.min(job.nextDue - this.clock.now(), MAX_TIMER_MS));
    job.timer = this.clock.setTimeout(() => this.onTimer(job), delay);
  }

  private onTimer(job: Job): void {
    job.timer = undefined;
    if (this.jobs.get(job.id) !== job || job.nextDue === null) return;
    const now = this.clock.now();
    if (now < job.nextDue) return this.arm(job); // a capped wait expired early
    const due = job.nextDue;
    // Next due time from the due time, not from now, so a slow event loop does not drift; slots already passed are dropped.
    let next = this.next(job, due);
    while (next !== null && next <= now) next = this.next(job, next);
    job.nextDue = next;
    if (job.catchup !== undefined) {
      // A scheduled run makes a pending catch-up redundant.
      this.clock.clearTimeout(job.catchup);
      job.catchup = undefined;
    }
    this.guard(job, () => {
      this.store.setLastDue(job.id, due);
      this.startOrSkip(job, "schedule");
    });
    this.arm(job);
  }

  private catchUp(job: Job, missed: number): void {
    job.catchup = undefined;
    if (this.jobs.get(job.id) !== job) return;
    this.guard(job, () => {
      this.store.setLastDue(job.id, missed);
      this.startOrSkip(job, "catch-up");
    });
  }

  private startOrSkip(job: Job, trigger: JobTrigger): void {
    if (!this.active.has(job.id)) {
      this.start(job, trigger);
      return;
    }
    this.store.insertSkipped(job.id, trigger, this.clock.now());
    this.log.warn(`job ${job.id}: skipped (${trigger}), previous run still in progress`);
  }

  /** Scheduler-internal failures (e.g. the database) are logged, never thrown into a timer callback. */
  private guard(job: Job, fn: () => void): void {
    try {
      fn();
    } catch (e) {
      this.log.error(`job ${job.id}: could not start: ${message(e)}`);
    }
  }

  private start(job: Job, trigger: JobTrigger): string {
    const startedAt = this.clock.now();
    const runId = this.store.startRun(job.id, trigger, startedAt);
    const controller = new AbortController();
    const run: Run = { jobId: job.id, runId, startedAt, controller, done: Promise.resolve() };
    this.active.set(job.id, run);
    this.log.log(`job ${job.id}: started (${trigger})`);
    const timeoutMs = job.spec.timeoutMs;
    const timeout = timeoutMs === undefined ? undefined : this.clock.setTimeout(() => {
      run.reason ??= { kind: "timeout", message: `timed out after ${timeoutMs} ms` };
      controller.abort(new Error(run.reason.message));
    }, timeoutMs);
    run.done = (async () => {
      let outcome: JobOutcome = "ok";
      let summary: string | undefined;
      let error: string | undefined;
      try {
        const r = await job.spec.run({ signal: controller.signal, log: prefixedLogger(job.owner, this.log), trigger });
        if (r && typeof r.summary === "string") summary = r.summary;
      } catch (e) {
        outcome = "failed";
        error = message(e);
      }
      if (run.reason) {
        outcome = run.reason.kind === "timeout" ? "failed" : "cancelled";
        error = run.reason.message;
      }
      if (timeout !== undefined) this.clock.clearTimeout(timeout);
      const finishedAt = this.clock.now();
      try {
        this.store.finishRun(runId, finishedAt, outcome, summary, error);
      } catch (e) {
        this.log.error(`job ${job.id}: could not record the run: ${message(e)}`);
      }
      if (this.active.get(job.id) === run) this.active.delete(job.id);
      const took = `${outcome} in ${finishedAt - startedAt} ms`;
      if (outcome === "ok") this.log.log(`job ${job.id}: ${took}${summary ? `: ${summary}` : ""}`);
      else if (outcome === "failed") this.log.error(`job ${job.id}: ${took}: ${error}`);
      else this.log.warn(`job ${job.id}: ${took}: ${error}`);
    })();
    return runId;
  }

  private async cancel(jobs: Job[], why: string): Promise<void> {
    const runs: Run[] = [];
    for (const job of jobs) {
      this.jobs.delete(job.id);
      if (job.timer !== undefined) this.clock.clearTimeout(job.timer);
      if (job.catchup !== undefined) this.clock.clearTimeout(job.catchup);
      const run = this.active.get(job.id);
      if (!run) continue;
      runs.push(run);
      run.reason ??= { kind: "cancelled", message: `cancelled: ${why}` };
      run.controller.abort(new Error(run.reason.message));
    }
    if (!runs.length) return;
    let timer: unknown;
    const grace = new Promise<void>((r) => (timer = this.clock.setTimeout(r, this.graceMs)));
    await Promise.race([Promise.all(runs.map((r) => r.done)), grace]);
    this.clock.clearTimeout(timer);
    for (const r of runs) {
      if (this.active.get(r.jobId) === r) this.log.warn(`job ${r.jobId}: still running ${this.graceMs} ms after it was cancelled; it cannot run again until it settles`);
    }
  }
}
