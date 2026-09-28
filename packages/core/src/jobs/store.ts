/** Job run history and catch-up state in friday.db (job_runs, job_state; migration 3). */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { JobOutcome, JobTrigger } from "@friday/sdk";

export type RunOutcome = JobOutcome | "running";

export interface JobRunRecord {
  id: string;
  jobId: string;
  trigger: JobTrigger;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  outcome: RunOutcome;
  summary?: string;
  error?: string;
}

export const SUMMARY_MAX = 500;
export const ERROR_MAX = 2000;

interface Row {
  id: string;
  job_id: string;
  trigger: string;
  started_at: string;
  finished_at: string | null;
  outcome: string;
  summary: string | null;
  error: string | null;
}

const iso = (ms: number) => new Date(ms).toISOString();
const cap = (s: string | undefined, max: number) => (s === undefined ? null : s.length > max ? s.slice(0, max - 1) + "…" : s);

function toRecord(r: Row): JobRunRecord {
  return {
    id: r.id,
    jobId: r.job_id,
    trigger: r.trigger as JobTrigger,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    durationMs: r.finished_at === null ? null : Date.parse(r.finished_at) - Date.parse(r.started_at),
    outcome: r.outcome as RunOutcome,
    ...(r.summary !== null ? { summary: r.summary } : {}),
    ...(r.error !== null ? { error: r.error } : {}),
  };
}

export class JobStore {
  /** `history`: runs kept per job (FRIDAY_JOB_HISTORY). */
  constructor(private readonly db: DatabaseSync, readonly history = 50) {}

  /** Insert a run with outcome `running` and prune older runs of the job, in one transaction. */
  startRun(jobId: string, trigger: JobTrigger, startedAt: number): string {
    return this.insert(jobId, trigger, startedAt, null, "running");
  }

  /** Record a due time that did not start because the previous run was still going. */
  insertSkipped(jobId: string, trigger: JobTrigger, at: number): string {
    return this.insert(jobId, trigger, at, at, "skipped");
  }

  finishRun(id: string, finishedAt: number, outcome: JobOutcome, summary?: string, error?: string): void {
    this.db.prepare("UPDATE job_runs SET finished_at = ?, outcome = ?, summary = ?, error = ? WHERE id = ?").run(iso(finishedAt), outcome, cap(summary, SUMMARY_MAX), cap(error, ERROR_MAX), id);
  }

  /** Newest first. */
  runs(jobId: string, limit = this.history): JobRunRecord[] {
    return (this.db.prepare("SELECT * FROM job_runs WHERE job_id = ? ORDER BY started_at DESC, rowid DESC LIMIT ?").all(jobId, limit) as unknown as Row[]).map(toRecord);
  }

  /** The most recently finished run (skipped runs included), or undefined. */
  lastRun(jobId: string): JobRunRecord | undefined {
    const row = this.db.prepare("SELECT * FROM job_runs WHERE job_id = ? AND outcome != 'running' ORDER BY finished_at DESC, rowid DESC LIMIT 1").get(jobId) as Row | undefined;
    return row ? toRecord(row) : undefined;
  }

  lastDue(jobId: string): number | undefined {
    const row = this.db.prepare("SELECT last_due_at FROM job_state WHERE job_id = ?").get(jobId) as { last_due_at: string } | undefined;
    return row ? Date.parse(row.last_due_at) : undefined;
  }

  setLastDue(jobId: string, due: number): void {
    this.db.prepare("INSERT INTO job_state (job_id, last_due_at) VALUES (?, ?) ON CONFLICT(job_id) DO UPDATE SET last_due_at = excluded.last_due_at").run(jobId, iso(due));
  }

  /** At startup: runs still `running` were interrupted by a crash or kill. Returns how many. */
  markInterrupted(at: number): number {
    return Number(this.db.prepare("UPDATE job_runs SET outcome = 'cancelled', finished_at = ?, error = 'interrupted by restart' WHERE outcome = 'running'").run(iso(at)).changes);
  }

  private insert(jobId: string, trigger: JobTrigger, startedAt: number, finishedAt: number | null, outcome: RunOutcome): string {
    const id = randomUUID();
    this.db.exec("BEGIN");
    try {
      this.db.prepare("INSERT INTO job_runs (id, job_id, trigger, started_at, finished_at, outcome) VALUES (?, ?, ?, ?, ?, ?)").run(id, jobId, trigger, iso(startedAt), finishedAt === null ? null : iso(finishedAt), outcome);
      // A run still in progress is never pruned, even when newer skipped runs push it past the limit.
      this.db
        .prepare("DELETE FROM job_runs WHERE job_id = ? AND outcome != 'running' AND id NOT IN (SELECT id FROM job_runs WHERE job_id = ? ORDER BY started_at DESC, rowid DESC LIMIT ?)")
        .run(jobId, jobId, this.history);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return id;
  }
}
