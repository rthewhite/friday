/**
 * Alerts in friday.db: timers (and later alarms) with a due time and a target. The store only keeps rows; when and
 * how an alert rings is AlertService's business. Ids are short so the model can say them back ("timer k3f9").
 */
import { randomInt } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export type AlertKind = "timer";
export type AlertLanguage = "nl" | "en";
export type AlertState = "scheduled" | "ringing" | "acknowledged" | "cancelled" | "missed";
export type FinalState = Extract<AlertState, "acknowledged" | "cancelled" | "missed">;
/** Only devices for now; push notifications to a person are a later target kind. */
export type TargetKind = "device";

export const FINAL_STATES: readonly FinalState[] = ["acknowledged", "cancelled", "missed"];
/** Finished alerts kept for the portal; older ones are deleted. */
export const KEEP_FINISHED = 200;

export interface Alert {
  id: string;
  kind: AlertKind;
  label: string;
  language: AlertLanguage;
  dueAt: string;
  /** When the service next tries to ring it: the due time, or the next try after an unanswered ring. */
  nextRingAt: string;
  target: { kind: TargetKind; id: string };
  state: AlertState;
  /** Unanswered rings so far. */
  rings: number;
  /** The device rings it with its own tone; the service doesn't ring it again. */
  local: boolean;
  createdAt: string;
  conversationId: string | null;
  /** When it was last snoozed; its due time then counts from here, not from createdAt. */
  snoozedAt: string | null;
  finishedAt: string | null;
}

export interface NewAlert {
  kind: AlertKind;
  label: string;
  language: AlertLanguage;
  dueAt: Date;
  target: { kind: TargetKind; id: string };
  conversationId?: string;
}

export interface AlertPatch {
  state?: AlertState;
  dueAt?: Date;
  nextRingAt?: Date;
  rings?: number;
  local?: boolean;
  snoozedAt?: Date;
}

interface AlertRow {
  id: string;
  kind: AlertKind;
  label: string;
  language: AlertLanguage;
  due_at: string;
  next_ring_at: string;
  target_kind: TargetKind;
  target_id: string;
  state: AlertState;
  rings: number;
  local: number;
  created_at: string;
  conversation_id: string | null;
  snoozed_at: string | null;
  finished_at: string | null;
}

/** Lowercase base32 without 0/1/l/o, so a spoken or typed id is hard to get wrong. */
const ID_ALPHABET = "23456789abcdefghijkmnpqrstuvwxyz";
const ID_LENGTH = 4;
const ACTIVE = "state IN ('scheduled', 'ringing')";

export const isFinal = (s: AlertState): s is FinalState => (FINAL_STATES as readonly string[]).includes(s);

export class AlertStore {
  private readonly now: () => Date;
  private readonly random: (max: number) => number;

  constructor(private readonly db: DatabaseSync, opts: { now?: () => Date; random?: (max: number) => number } = {}) {
    this.now = opts.now ?? (() => new Date());
    this.random = opts.random ?? ((max) => randomInt(max));
  }

  create(a: NewAlert): Alert {
    const id = this.newId();
    const due = a.dueAt.toISOString();
    this.db
      .prepare(
        `INSERT INTO alerts (id, kind, label, language, due_at, next_ring_at, target_kind, target_id, state, created_at, conversation_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'scheduled', ?, ?)`,
      )
      .run(id, a.kind, a.label, a.language, due, due, a.target.kind, a.target.id, this.iso(), a.conversationId ?? null);
    return this.get(id)!;
  }

  get(id: string): Alert | undefined {
    const row = this.db.prepare("SELECT * FROM alerts WHERE id = ?").get(id) as AlertRow | undefined;
    return row && toAlert(row);
  }

  /** Scheduled and ringing alerts by due time, then finished ones, newest first. */
  list(): Alert[] {
    return this.rows(
      `SELECT * FROM alerts ORDER BY CASE WHEN ${ACTIVE} THEN 0 ELSE 1 END,
         CASE WHEN ${ACTIVE} THEN due_at END, finished_at DESC, id`,
    );
  }

  /** Scheduled and ringing alerts, by due time; of one target when given. */
  active(target?: { kind: TargetKind; id: string }): Alert[] {
    if (!target) return this.rows(`SELECT * FROM alerts WHERE ${ACTIVE} ORDER BY due_at, id`);
    return this.rows(`SELECT * FROM alerts WHERE ${ACTIVE} AND target_kind = ? AND target_id = ? ORDER BY due_at, id`, target.kind, target.id);
  }

  /** Change an alert; entering a final state stamps `finished_at` and prunes old finished alerts. */
  update(id: string, patch: AlertPatch): Alert | undefined {
    const current = this.get(id);
    if (!current) return undefined;
    const state = patch.state ?? current.state;
    const finishedAt = isFinal(state) ? (current.finishedAt ?? this.iso()) : null;
    this.db
      .prepare("UPDATE alerts SET state = ?, due_at = ?, next_ring_at = ?, rings = ?, local = ?, snoozed_at = ?, finished_at = ? WHERE id = ?")
      .run(
        state,
        patch.dueAt?.toISOString() ?? current.dueAt,
        patch.nextRingAt?.toISOString() ?? current.nextRingAt,
        patch.rings ?? current.rings,
        (patch.local ?? current.local) ? 1 : 0,
        patch.snoozedAt?.toISOString() ?? current.snoozedAt,
        finishedAt,
        id,
      );
    if (isFinal(state) && !current.finishedAt) this.prune();
    return this.get(id);
  }

  /** Cancel every scheduled and ringing alert of a target (its device was deleted); returns what was cancelled. */
  cancelTarget(target: { kind: TargetKind; id: string }): Alert[] {
    return this.active(target).map((a) => this.update(a.id, { state: "cancelled" })!);
  }

  /** Clear every `local` flag: after a restart devices report their local rings again when rung. */
  resetLocal(): void {
    this.db.prepare("UPDATE alerts SET local = 0 WHERE local = 1").run();
  }

  /** Delete all but the newest KEEP_FINISHED finished alerts. */
  prune(): void {
    this.db
      .prepare(
        `DELETE FROM alerts WHERE NOT (${ACTIVE}) AND id NOT IN
           (SELECT id FROM alerts WHERE NOT (${ACTIVE}) ORDER BY finished_at DESC, id LIMIT ?)`,
      )
      .run(KEEP_FINISHED);
  }

  /** A short id no stored alert has. */
  private newId(): string {
    for (;;) {
      let id = "";
      for (let i = 0; i < ID_LENGTH; i++) id += ID_ALPHABET[this.random(ID_ALPHABET.length)];
      if (!this.db.prepare("SELECT 1 FROM alerts WHERE id = ?").get(id)) return id;
    }
  }

  private rows(sql: string, ...params: string[]): Alert[] {
    return (this.db.prepare(sql).all(...params) as unknown as AlertRow[]).map(toAlert);
  }

  private iso(): string {
    return this.now().toISOString();
  }
}

const toAlert = (r: AlertRow): Alert => ({
  id: r.id,
  kind: r.kind,
  label: r.label,
  language: r.language,
  dueAt: r.due_at,
  nextRingAt: r.next_ring_at,
  target: { kind: r.target_kind, id: r.target_id },
  state: r.state,
  rings: r.rings,
  local: r.local === 1,
  createdAt: r.created_at,
  conversationId: r.conversation_id,
  snoozedAt: r.snoozed_at,
  finishedAt: r.finished_at,
});
