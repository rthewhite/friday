/**
 * The Work calendar (design D4-D6): a read-only copy of the user's Outlook calendar that a Power Automate flow
 * delivers to the intake every hour. Reading the intake removes what it returns, so the newest usable delivery is
 * stored in ctx.storage before it is used, and a poll that finds nothing keeps the stored one. Every item is one
 * occurrence (the flow uses Outlook's calendar view), mapped for voice when read, so a mapping fix applies to the
 * stored copy at once.
 */
import { createHash } from "node:crypto";
import { localDate, startOfLocalDay, type ModuleLogger, type ModuleStorage } from "@friday/sdk";
import type { CalendarInfo } from "./caldav.js";
import { addDays, endOfLocalDay } from "./format.js";
import type { EventStatus, Occurrence } from "./ical.js";
import { INTAKE_SUBJECT, type IntakeClient } from "./intake.js";

export const WORK_CALENDAR_ID = "intake-work";
export const WORK_URL = "intake:work";
export const SNAPSHOT_KEY = "work-snapshot";
export const INTAKE_KEYS = ["INTAKE_URL", "INTAKE_KEY"] as const;
/** The window the Power Automate flow asks Outlook for, around the time it runs. Change it with the flow. */
export const COVERAGE = { monthsBack: 1, monthsAhead: 6 };
/** "Get events" capped at 256 items; a snapshot of exactly that many may have been cut off by the flow. */
export const FLOW_ITEM_CAP = 256;
/** The flow delivers hourly; a copy older than this means deliveries stopped arriving. */
export const WORK_STALE_AFTER_MS = 3 * 60 * 60_000;
export const WORK_READ_ONLY = "It is in the Work calendar, a copy of Outlook that Friday can only read; change it in Outlook.";

/** One event as the flow sends it (fields Friday doesn't use are ignored). */
export interface IntakeItem {
  subject: string;
  start: string;
  end: string;
  isAllDay: boolean;
  location?: string;
  organizer?: string;
  showAs?: string;
}

export interface Snapshot {
  messageId: string;
  /** The intake's `received_at`: roughly when the flow ran. */
  receivedAt: string;
  storedAt: string;
  items: IntakeItem[];
  /** Events in the delivery that were left out as invalid. */
  skipped: number;
  /** Why a newer delivery taken in the same poll couldn't be used instead (it is gone from the intake). */
  passedOver?: string;
}

export interface WorkPollStatus {
  polledAt?: string;
  ok?: boolean;
  error?: string;
}

/** What is worth knowing about a stored snapshot: cut off by the flow, or a newer delivery that was unusable. */
export function snapshotWarnings(s: Snapshot | undefined): string[] {
  if (!s) return [];
  const out: string[] = [];
  if (s.items.length + s.skipped === FLOW_ITEM_CAP) out.push(`The work calendar copy has exactly ${FLOW_ITEM_CAP} events, so the flow may have cut it off.`);
  if (s.passedOver) out.push(`A newer delivery couldn't be used: ${s.passedOver}.`);
  return out;
}

const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

const stampMs = (v: unknown): number | undefined => (typeof v === "string" && STAMP.test(v) && !Number.isNaN(Date.parse(v)) ? Date.parse(v) : undefined);

/** A string `subject`, offset date-times with `end` not before `start`, and a boolean `isAllDay`. */
export function isValidItem(v: unknown): v is IntakeItem {
  if (!v || typeof v !== "object") return false;
  const i = v as Record<string, unknown>;
  const start = stampMs(i.start), end = stampMs(i.end);
  return typeof i.subject === "string" && typeof i.isAllDay === "boolean" && start !== undefined && end !== undefined && end >= start;
}

const textOf = (v: unknown) => (typeof v === "string" ? v : undefined);

/** The fields Friday keeps of a valid item. */
function keep(i: IntakeItem): IntakeItem {
  const location = textOf(i.location), organizer = textOf(i.organizer), showAs = textOf(i.showAs);
  return { subject: i.subject, start: i.start, end: i.end, isAllDay: i.isAllDay, ...(location ? { location } : {}), ...(organizer ? { organizer } : {}), ...(showAs ? { showAs } : {}) };
}

export type DeliveryChoice =
  | { kind: "none"; reason: string }
  | { kind: "unusable"; reason: string }
  | { kind: "snapshot"; snapshot: Omit<Snapshot, "storedAt"> };

/**
 * Chooses what a poll's messages mean for the stored snapshot: the newest usable calendar delivery newer than
 * `storedAt` (the later one in the array on a tie), nothing new, or only unusable deliveries.
 */
export function pickDelivery(messages: unknown[], storedReceivedAt?: string): DeliveryChoice {
  const stored = storedReceivedAt ? Date.parse(storedReceivedAt) : -Infinity;
  const candidates = messages
    .map((m, index) => ({ m: m as Record<string, unknown>, index }))
    .filter(({ m }) => !!m && typeof m === "object" && m.subject === INTAKE_SUBJECT)
    .map((c) => ({ ...c, at: typeof c.m.received_at === "string" ? Date.parse(c.m.received_at) : NaN }))
    .filter((c) => !Number.isNaN(c.at) && c.at > stored)
    .sort((a, b) => b.at - a.at || b.index - a.index);
  if (!candidates.length) return { kind: "none", reason: messages.length ? "no calendar delivery newer than the stored copy" : "nothing waiting" };
  let firstReason: string | undefined;
  for (const { m } of candidates) {
    const content = m.content;
    if (!Array.isArray(content)) {
      firstReason ??= `the delivery received at ${String(m.received_at)} has no list of events`;
      continue;
    }
    const valid = content.filter(isValidItem);
    if (content.length && !valid.length) {
      firstReason ??= `none of the ${content.length} events in the delivery received at ${String(m.received_at)} is valid (each needs a subject, isAllDay, and start and end with an offset)`;
      continue;
    }
    return {
      kind: "snapshot",
      snapshot: {
        messageId: String(m.id ?? ""),
        receivedAt: new Date(Date.parse(String(m.received_at))).toISOString(),
        items: valid.map(keep),
        skipped: content.length - valid.length,
        ...(firstReason ? { passedOver: firstReason } : {}),
      },
    };
  }
  return { kind: "unusable", reason: firstReason! };
}

const CANCELLED = /^\s*(geannuleerd|canceled|cancelled)\s*:\s*/i;
const SHOW_AS: Record<string, EventStatus> = { tentative: "tentative", free: "free", oof: "out of office" };

/** `Microsoft Teams Meeting; _Video Conference; SkyLounge` -> `online, Video Conference, SkyLounge`. */
export function workLocation(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  let online = false;
  const rest: string[] = [];
  for (const part of raw.split(";").map((p) => p.trim())) {
    if (/^https?:\/\//i.test(part) || /^microsoft teams meeting$/i.test(part)) online = true;
    else {
      const name = part.replace(/^_+/, "").trim();
      if (name) rest.push(name);
    }
  }
  const parts = online ? ["online", ...rest] : rest;
  return parts.length ? parts.join(", ") : undefined;
}

/** Stable while the meeting's title and times are: survives the hourly snapshot. */
export function workKey(i: Pick<IntakeItem, "subject" | "start" | "end">): string {
  return createHash("sha256").update(`${i.subject}|${Date.parse(i.start)}|${Date.parse(i.end)}`).digest("hex").slice(0, 16);
}

/** The occurrence an item stands for. All-day events keep the dates as written; timed ones are instants. */
export function toOccurrence(item: IntakeItem, zone: string): Occurrence {
  const cancelled = CANCELLED.test(item.subject);
  const title = item.subject.replace(CANCELLED, "").trim() || "(no title)";
  const status: EventStatus | undefined = cancelled ? "cancelled" : SHOW_AS[(item.showAs ?? "").toLowerCase()];
  const location = workLocation(item.location);
  const base = {
    uid: workKey(item),
    title,
    recurring: false,
    ...(status ? { status } : {}),
    ...(location ? { location } : {}),
    ...(item.organizer ? { organizer: item.organizer.toLowerCase() } : {}),
  };
  if (item.isAllDay) {
    const startDate = item.start.slice(0, 10);
    let endDate = item.end.slice(0, 10);
    if (endDate <= startDate) endDate = addDays(startDate, 1);
    return { ...base, allDay: true, startDate, endDate, startMs: startOfLocalDay(startDate, zone)!.getTime(), endMs: startOfLocalDay(endDate, zone)!.getTime() };
  }
  return { ...base, allDay: false, startMs: Date.parse(item.start), endMs: Date.parse(item.end) };
}

/** `YYYY-MM-DD` moved by whole calendar months, clamped to the end of a shorter month. */
export function addMonths(date: string, months: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const first = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  return new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(d, last))).toISOString().slice(0, 10);
}

export interface Coverage {
  /** First and last day covered, inclusive. */
  from: string;
  to: string;
  fromMs: number;
  toMs: number;
}

/** The days the flow's window covered when it sent the snapshot received at `receivedAt`. */
export function coverage(receivedAt: string, zone: string): Coverage {
  const day = localDate(new Date(receivedAt), zone);
  const from = addMonths(day, -COVERAGE.monthsBack), to = addMonths(day, COVERAGE.monthsAhead);
  return { from, to, fromMs: startOfLocalDay(from, zone)!.getTime(), toMs: endOfLocalDay(to, zone).getTime() };
}

const LONG_DAY = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
/** "10 September 2026" */
const longDay = (date: string) => {
  const [y, m, d] = date.split("-").map(Number);
  return LONG_DAY.format(new Date(Date.UTC(y, m - 1, d)));
};

export function coverageText(c: Coverage): string {
  return `The Work calendar only covers ${longDay(c.from)} to ${longDay(c.to)}; there may be work events outside that.`;
}

export interface WorkSourceDeps {
  storage: ModuleStorage;
  client: IntakeClient;
  /** Config as the module sees it, read for every check. */
  config: { get(key: string): string | undefined };
  now: () => Date;
  log?: ModuleLogger;
}

export class WorkSource {
  status: WorkPollStatus = {};
  private stored?: Snapshot;
  private mapped?: { snapshot: Snapshot; zone: string; occurrences: Occurrence[] };

  constructor(private readonly d: WorkSourceDeps) {}

  /** Intake keys that are not set; the source is configured when there are none. */
  missing(): string[] {
    return INTAKE_KEYS.filter((k) => !this.d.config.get(k)?.trim());
  }

  get configured(): boolean {
    return this.missing().length === 0;
  }

  get snapshot(): Snapshot | undefined {
    return this.stored;
  }

  /** Loads the stored snapshot (before the first prompt is built). */
  async load(): Promise<void> {
    const s = await this.d.storage.get<Snapshot>(SNAPSHOT_KEY);
    if (s && typeof s === "object" && Array.isArray(s.items) && typeof s.receivedAt === "string") this.stored = s;
  }

  /** The Work calendar entry; renamed when iCloud has a calendar of the same name. */
  calendar(otherNames: string[]): CalendarInfo {
    const clash = otherNames.some((n) => n.trim().toLowerCase() === "work");
    return { id: WORK_CALENDAR_ID, url: WORK_URL, name: clash ? "Work (Outlook)" : "Work", writable: false, source: "intake" };
  }

  /** Takes what the intake has; stores a newer usable delivery, then uses it. Throws when the poll failed. */
  async poll(signal?: AbortSignal): Promise<string> {
    const polledAt = this.d.now().toISOString();
    try {
      const messages = await this.d.client.poll(signal);
      const pick = pickDelivery(messages, this.stored?.receivedAt);
      if (pick.kind === "unusable") throw new Error(`The work calendar delivery could not be used: ${pick.reason}. The previous copy is kept.`);
      if (pick.kind === "none") {
        this.status = { polledAt, ok: true };
        return pick.reason;
      }
      const snapshot: Snapshot = { ...pick.snapshot, storedAt: polledAt };
      // Stored before it is used: the intake has already forgotten it.
      await this.d.storage.set(SNAPSHOT_KEY, snapshot);
      this.stored = snapshot;
      for (const w of snapshotWarnings(snapshot)) this.d.log?.warn(w);
      if (snapshot.skipped) this.d.log?.warn(`left out ${snapshot.skipped} invalid event${snapshot.skipped === 1 ? "" : "s"} of the work calendar delivery`);
      this.status = { polledAt, ok: true };
      return `${snapshot.items.length} event${snapshot.items.length === 1 ? "" : "s"} received`;
    } catch (e) {
      this.status = { polledAt, ok: false, error: e instanceof Error ? e.message : String(e) };
      throw e;
    }
  }

  /** The snapshot's occurrences overlapping [from, to), mapped once per snapshot and zone. */
  occurrences(from: number, to: number, zone: string): Occurrence[] {
    const s = this.stored;
    if (!s) return [];
    if (this.mapped?.snapshot !== s || this.mapped.zone !== zone) this.mapped = { snapshot: s, zone, occurrences: s.items.map((i) => toOccurrence(i, zone)) };
    return this.mapped.occurrences.filter((o) => (o.endMs > o.startMs ? o.startMs < to && o.endMs > from : o.startMs >= from && o.startMs < to));
  }

  coverage(zone: string): Coverage | undefined {
    return this.stored ? coverage(this.stored.receivedAt, zone) : undefined;
  }

  /** Warnings about the stored copy; they last as long as that copy does. */
  warnings(): string[] {
    return snapshotWarnings(this.stored);
  }

  /** True when the stored copy is older than the agenda accepts without a note (deliveries stopped). */
  stale(): boolean {
    return !!this.stored && this.d.now().getTime() - Date.parse(this.stored.receivedAt) > WORK_STALE_AFTER_MS;
  }
}

