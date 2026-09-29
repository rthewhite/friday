/**
 * The nightly run record (design D1, brain migration 2). The brain keeps its own table next to the
 * Jobs page history because the review needs each run's revision range, dropped lines and merges.
 */
import type { ModuleDb } from "@friday/sdk";

export type RunOutcome = "ok" | "partial" | "failed";

export interface DroppedLine {
  pageId: string;
  page: string;
  line: string;
  reason: string;
}

export interface MergeRecord {
  from: string;
  into: string;
}

export interface RunCounts {
  /** Conversations handled, trivial ones included. */
  conversations: number;
  /** Conversations skipped as trivial (no model call). */
  skipped: number;
  /** Notes appended. */
  notes: number;
  /** Notes the brain refused (tombstoned, invalid). */
  refused: number;
  rewrites: number;
  creates: number;
  merges: number;
}

export interface Run extends RunCounts {
  id: number;
  trigger: string;
  startedAt: string;
  finishedAt?: string;
  /** Unset while the run is in progress. */
  outcome?: RunOutcome;
  dropped: DroppedLine[];
  mergeRecords: MergeRecord[];
  /** Revisions this run may have written have ids in [firstRevisionId, lastRevisionId]. */
  firstRevisionId: number;
  lastRevisionId?: number;
  error?: string;
}

export interface RunFinish extends Partial<RunCounts> {
  outcome: RunOutcome;
  dropped?: DroppedLine[];
  merges?: number;
  mergeRecords?: MergeRecord[];
  error?: string;
}

interface RunRow {
  id: number;
  trigger: string;
  started_at: string;
  finished_at: string | null;
  outcome: string | null;
  conversations: number;
  skipped: number;
  notes: number;
  refused: number;
  rewrites: number;
  creates: number;
  merges: number;
  dropped_json: string;
  merges_json: string;
  first_revision_id: number;
  last_revision_id: number | null;
  error: string | null;
}

const toRun = (r: RunRow): Run => ({
  id: r.id,
  trigger: r.trigger,
  startedAt: r.started_at,
  ...(r.finished_at ? { finishedAt: r.finished_at } : {}),
  ...(r.outcome ? { outcome: r.outcome as RunOutcome } : {}),
  conversations: r.conversations,
  skipped: r.skipped,
  notes: r.notes,
  refused: r.refused,
  rewrites: r.rewrites,
  creates: r.creates,
  merges: r.merges,
  dropped: JSON.parse(r.dropped_json) as DroppedLine[],
  mergeRecords: JSON.parse(r.merges_json) as MergeRecord[],
  firstRevisionId: r.first_revision_id,
  ...(r.last_revision_id !== null ? { lastRevisionId: r.last_revision_id } : {}),
  ...(r.error !== null ? { error: r.error } : {}),
});

export class RunStore {
  constructor(private readonly db: ModuleDb, private readonly now: () => Date = () => new Date()) {}

  /** The id the next revision will get (revision ids are AUTOINCREMENT, so never reused). */
  nextRevisionId(): number {
    const seq = this.db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'brain__revisions'").get() as { seq: number } | undefined;
    const max = (this.db.prepare("SELECT max(id) AS m FROM brain__revisions").get() as { m: number | null }).m ?? 0;
    return Math.max(seq?.seq ?? 0, max) + 1;
  }

  start(trigger: string): Run {
    const id = Number(this.db
      .prepare("INSERT INTO brain__runs (trigger, started_at, first_revision_id) VALUES (?, ?, ?)")
      .run(trigger, this.now().toISOString(), this.nextRevisionId()).lastInsertRowid);
    return this.get(id)!;
  }

  finish(id: number, f: RunFinish): Run {
    this.db
      .prepare(`UPDATE brain__runs SET finished_at = ?, outcome = ?, conversations = ?, skipped = ?, notes = ?, refused = ?,
        rewrites = ?, creates = ?, merges = ?, dropped_json = ?, merges_json = ?, last_revision_id = ?, error = ? WHERE id = ?`)
      .run(
        this.now().toISOString(), f.outcome, f.conversations ?? 0, f.skipped ?? 0, f.notes ?? 0, f.refused ?? 0,
        f.rewrites ?? 0, f.creates ?? 0, f.merges ?? f.mergeRecords?.length ?? 0,
        JSON.stringify(f.dropped ?? []), JSON.stringify(f.mergeRecords ?? []), this.nextRevisionId() - 1, f.error ?? null, id,
      );
    return this.get(id)!;
  }

  get(id: number): Run | undefined {
    const row = this.db.prepare("SELECT * FROM brain__runs WHERE id = ?").get(id) as RunRow | undefined;
    return row && toRun(row);
  }

  /** Newest first. */
  list(limit = 14): Run[] {
    return (this.db.prepare("SELECT * FROM brain__runs ORDER BY id DESC LIMIT ?").all(limit) as unknown as RunRow[]).map(toRun);
  }
}
