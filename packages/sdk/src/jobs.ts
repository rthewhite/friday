/**
 * Background jobs: the declaration contract shared by core's scheduler and the test host.
 * Both hosts validate through `validateJob`, so they reject exactly the same declarations.
 */
import { Cron } from "croner";
import type { ModuleLogger } from "./module.js";

/** Why a run started: its schedule, a catch-up after downtime, the API, or the owner itself. */
export type JobTrigger = "schedule" | "catch-up" | "manual" | "module";
export type JobOutcome = "ok" | "failed" | "skipped" | "cancelled";

/** Optional handler result; `summary` is shown in the run history (capped at 500 characters). */
export interface JobResult {
  summary?: string;
}

/** What a running handler receives. Stop work when `signal` aborts (timeout, dispose or shutdown). */
export interface JobContext {
  signal: AbortSignal;
  log: ModuleLogger;
  trigger: JobTrigger;
}

export interface JobSpec {
  /** kebab-case, unique per owner. The job id is `<owner>/<name>`. */
  name: string;
  description?: string;
  /** Five-field cron expression, evaluated in FRIDAY_TIMEZONE. Exactly one of `cron` / `everyMs`. */
  cron?: string;
  /** Fixed interval in milliseconds, at least 1000. */
  everyMs?: number;
  /** Abort the run's signal after this long and record it as `failed`. */
  timeoutMs?: number;
  run(job: JobContext): void | JobResult | Promise<void | JobResult>;
}

/** `ctx.jobs`: in-process modules only. */
export interface ModuleJobs {
  /** Declare a job owned by this module. Throws on an invalid declaration, failing `init`. */
  schedule(job: JobSpec): void;
  /** Start one of this module's jobs now (trigger `module`); `started` is false when it is already running. */
  trigger(name: string): { started: boolean };
}

export const MIN_JOB_INTERVAL_MS = 1000;

const NAME = /^[a-z][a-z0-9-]*$/;

const parseCron = (expr: string, timezone?: string) => new Cron(expr, { paused: true, mode: "5-part", timezone });

/** Throws `job <owner>/<name>: ...` when a declaration is malformed or its name is in `existing`. */
export function validateJob(owner: string, job: JobSpec, existing?: { has(name: string): boolean }): void {
  const label = `job ${owner}/${typeof job?.name === "string" ? job.name : JSON.stringify(job?.name)}`;
  if (!job || typeof job.name !== "string" || !NAME.test(job.name)) throw new Error(`${label}: name must be kebab-case`);
  if (existing?.has(job.name)) throw new Error(`${label}: a job with this name is already scheduled`);
  if (typeof job.run !== "function") throw new Error(`${label}: run must be a function`);
  const hasCron = job.cron !== undefined, hasEvery = job.everyMs !== undefined;
  if (hasCron === hasEvery) throw new Error(`${label}: declare exactly one of cron or everyMs`);
  if (hasCron) {
    if (typeof job.cron !== "string") throw new Error(`${label}: cron must be a string`);
    try {
      parseCron(job.cron);
    } catch (e) {
      throw new Error(`${label}: invalid cron "${job.cron}": ${e instanceof Error ? e.message : e}`);
    }
  }
  if (hasEvery && (typeof job.everyMs !== "number" || !Number.isFinite(job.everyMs) || job.everyMs < MIN_JOB_INTERVAL_MS)) {
    throw new Error(`${label}: everyMs must be at least ${MIN_JOB_INTERVAL_MS}`);
  }
  if (job.timeoutMs !== undefined && (typeof job.timeoutMs !== "number" || !Number.isFinite(job.timeoutMs) || job.timeoutMs <= 0)) {
    throw new Error(`${label}: timeoutMs must be a positive number`);
  }
}

/** The first due time of a cron expression strictly after `after`, in `timezone`. For hosts. */
export function nextCronRun(expr: string, timezone: string, after: Date): Date | null {
  return parseCron(expr, timezone).nextRun(after);
}
