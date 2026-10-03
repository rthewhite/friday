/** Types, the API client and pure helpers for /m/calendar. */

export interface CalendarRow {
  id: string;
  name: string;
  color: string | null;
  writable: boolean;
  use: boolean;
  inAgenda: boolean;
  default: boolean;
}

export interface Status {
  username: string | null;
  connected: boolean;
  checkedAt: string | null;
  error: string | null;
  calendars: CalendarRow[];
}

export interface Summary {
  title: string;
  when: string;
  calendar?: string;
  location?: string;
}

export interface ChangeRow {
  id: number;
  at: string;
  source: "voice" | "chat" | "portal";
  conversationId?: string;
  action: "create" | "update" | "delete" | "undo";
  scope?: "occurrence" | "series";
  title: string;
  before: Summary | null;
  after: Summary | null;
  undoOf?: number;
  undone: boolean;
  undoable: boolean;
}

export class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly body: Record<string, unknown>) {
    super(message);
  }
}

/** JSON call to the calendar's routes; non-2xx answers throw an `ApiError` carrying the body. */
export async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/modules/calendar/${path}`, {
    method,
    ...(body !== undefined ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new ApiError(res.status, String(data.error ?? res.statusText), data);
  return data as T;
}

const SCOPE = { occurrence: " (one occurrence)", series: " (whole series)" } as const;

/** "Created", "Changed (whole series)", "Deleted (one occurrence)", "Undo". */
export function actionLabel(c: Pick<ChangeRow, "action" | "scope">): string {
  const base = { create: "Created", update: "Changed", delete: "Deleted", undo: "Undo" }[c.action];
  return base + (c.scope ? SCOPE[c.scope] : "");
}

const describe = (s: Summary | null) => (s ? `"${s.title}" ${s.when}${s.location ? `, ${s.location}` : ""}` : "");

/** The before and after of a change as one line: `"Dentist" Thu 8 Oct, 14:00-15:00 -> "Dentist" Thu 8 Oct, 15:00-16:00`. */
export function changeDetail(c: Pick<ChangeRow, "action" | "before" | "after">): string {
  if (c.action === "create") return describe(c.after);
  if (c.action === "delete") return describe(c.before);
  const before = describe(c.before), after = describe(c.after);
  if (!before) return after;
  if (!after) return `${before} -> (removed)`;
  return before === after ? after : `${before} -> ${after}`;
}

/** The PUT settings body for one toggle or the default. */
export function settingsPatch(row: Pick<CalendarRow, "id">, change: { use?: boolean; inAgenda?: boolean; default?: true }): Record<string, unknown> {
  if (change.default) return { defaultId: row.id };
  return { calendars: { [row.id]: { ...(change.use !== undefined ? { use: change.use } : {}), ...(change.inAgenda !== undefined ? { inAgenda: change.inAgenda } : {}) } } };
}
