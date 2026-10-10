/** Types, the API client and pure helpers for /m/calendar. */

export interface CalendarRow {
  id: string;
  name: string;
  color: string | null;
  writable: boolean;
  source: "icloud" | "intake";
  use: boolean;
  inAgenda: boolean;
  default: boolean;
}

/** The Work calendar's copy from the intake, and the last poll. */
export interface WorkStatus {
  configured: boolean;
  missing?: string[];
  receivedAt: string | null;
  events: number | null;
  skipped: number | null;
  coverage: { from: string; to: string } | null;
  polledAt: string | null;
  ok: boolean | null;
  error: string | null;
  warning: string | null;
  /** The server's verdict that the copy is older than the agenda accepts without a note. */
  stale: boolean;
}

export interface Status {
  icloud: { configured: boolean; missing?: string[] };
  username: string | null;
  connected: boolean;
  checkedAt: string | null;
  error: string | null;
  work: WorkStatus;
  calendars: CalendarRow[];
}

export type Tone = "neutral" | "success" | "warning" | "error";

/** How the Work calendar is doing, for its status dot. */
export function workState(w: WorkStatus): { tone: Tone; label: string } {
  if (!w.configured) return { tone: "neutral", label: "Not configured" };
  if (w.ok === false) return { tone: "error", label: "Last poll failed" };
  if (!w.receivedAt) return { tone: "warning", label: "Nothing received yet" };
  if (w.stale) return { tone: "warning", label: "Out of date" };
  return { tone: "success", label: "Up to date" };
}

const DAY = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const day = (date: string) => DAY.format(new Date(`${date}T00:00:00Z`));

/** "218 events, 3 Sep 2026 to 3 Apr 2027 (2 left out as invalid)". */
export function workSummary(w: Pick<WorkStatus, "events" | "skipped" | "coverage">): string {
  if (w.events === null) return "";
  const events = `${w.events} event${w.events === 1 ? "" : "s"}`;
  const range = w.coverage ? `, ${day(w.coverage.from)} to ${day(w.coverage.to)}` : "";
  const skipped = w.skipped ? ` (${w.skipped} left out as invalid)` : "";
  return `${events}${range}${skipped}`;
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
