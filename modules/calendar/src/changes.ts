/** The change log in `calendar__changes` (design D6): every write Friday made, newest 500 kept. */
import type { ModuleDb } from "@friday/sdk";
import type { EventSummary } from "./service.js";

export const MAX_CHANGES = 500;
export const TOOL_UNDO_WINDOW_MS = 24 * 60 * 60_000;

export type ChangeAction = "create" | "update" | "delete" | "undo";
export type ChangeSource = "voice" | "chat" | "portal";

export interface NewChange {
  action: ChangeAction;
  scope?: "occurrence" | "series";
  calendarId: string;
  objectUrl: string;
  uid: string;
  title: string;
  beforeSummary: EventSummary | null;
  afterSummary: EventSummary | null;
  beforeIcs: string | null;
  afterIcs: string | null;
  afterEtag: string | null;
  source: ChangeSource;
  conversationId?: string;
  undoOf?: number;
}

export interface Change extends NewChange {
  id: number;
  at: string;
  undoneBy?: number;
}

interface Row {
  id: number;
  at: string;
  action: ChangeAction;
  scope: string | null;
  calendar_id: string;
  object_url: string;
  uid: string;
  title: string;
  before_summary: string | null;
  after_summary: string | null;
  before_ics: string | null;
  after_ics: string | null;
  after_etag: string | null;
  source: ChangeSource;
  conversation_id: string | null;
  undo_of: number | null;
  undone_by: number | null;
}

const json = (s: string | null): EventSummary | null => (s ? (JSON.parse(s) as EventSummary) : null);

function toChange(r: Row): Change {
  return {
    id: r.id,
    at: r.at,
    action: r.action,
    ...(r.scope ? { scope: r.scope as Change["scope"] } : {}),
    calendarId: r.calendar_id,
    objectUrl: r.object_url,
    uid: r.uid,
    title: r.title,
    beforeSummary: json(r.before_summary),
    afterSummary: json(r.after_summary),
    beforeIcs: r.before_ics,
    afterIcs: r.after_ics,
    afterEtag: r.after_etag,
    source: r.source,
    ...(r.conversation_id ? { conversationId: r.conversation_id } : {}),
    ...(r.undo_of !== null ? { undoOf: r.undo_of } : {}),
    ...(r.undone_by !== null ? { undoneBy: r.undone_by } : {}),
  };
}

export class ChangeLog {
  constructor(private readonly db: ModuleDb, private readonly now: () => Date) {}

  /** Logs a change (an undo also marks the change it reverted) and prunes beyond the newest 500. */
  record(c: NewChange): Change {
    return this.db.transaction(() => {
      const r = this.db
        .prepare(
          `INSERT INTO calendar__changes (at, action, scope, calendar_id, object_url, uid, title, before_summary, after_summary,
             before_ics, after_ics, after_etag, source, conversation_id, undo_of)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          this.now().toISOString(), c.action, c.scope ?? null, c.calendarId, c.objectUrl, c.uid, c.title,
          c.beforeSummary ? JSON.stringify(c.beforeSummary) : null, c.afterSummary ? JSON.stringify(c.afterSummary) : null,
          c.beforeIcs, c.afterIcs, c.afterEtag, c.source, c.conversationId ?? null, c.undoOf ?? null,
        );
      const id = Number(r.lastInsertRowid);
      if (c.undoOf !== undefined) this.db.prepare("UPDATE calendar__changes SET undone_by = ? WHERE id = ?").run(id, c.undoOf);
      this.db.prepare(`DELETE FROM calendar__changes WHERE id <= (SELECT id FROM calendar__changes ORDER BY id DESC LIMIT 1 OFFSET ?)`).run(MAX_CHANGES);
      return this.get(id)!;
    });
  }

  get(id: number): Change | undefined {
    const r = this.db.prepare("SELECT * FROM calendar__changes WHERE id = ?").get(id) as Row | undefined;
    return r ? toChange(r) : undefined;
  }

  /** Newest first. */
  list(limit: number): Change[] {
    return (this.db.prepare("SELECT * FROM calendar__changes ORDER BY id DESC LIMIT ?").all(limit) as unknown as Row[]).map(toChange);
  }

  /** The newest change a tool made in the last 24 hours that isn't an undo and wasn't undone. */
  lastToolChange(): Change | undefined {
    const since = new Date(this.now().getTime() - TOOL_UNDO_WINDOW_MS).toISOString();
    const r = this.db
      .prepare(`SELECT * FROM calendar__changes WHERE source IN ('voice', 'chat') AND action <> 'undo' AND undone_by IS NULL AND at >= ? ORDER BY id DESC LIMIT 1`)
      .get(since) as Row | undefined;
    return r ? toChange(r) : undefined;
  }
}
