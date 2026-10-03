/**
 * What the tools, routes and agenda job share: the account's calendars, listing, creating, previews and
 * confirmation, and undo. Every iCloud request goes through `icloud()`, which records the connection status the
 * portal shows.
 */
import { randomUUID } from "node:crypto";
import { localDate, startOfLocalDay, type ToolCallContext } from "@friday/sdk";
import type { Account, CalDavClient, CalendarInfo, CalendarObject } from "./caldav.js";
import { InputError, ReadOnlyError, UpstreamError } from "./errors.js";
import { addDays, endOfLocalDay, localIso, whenText, type Span } from "./format.js";
import type { EventHandles, EventRef } from "./handles.js";
import { buildEvent, expand, isInvitation, parseIcs, type Occurrence, type Repeat } from "./ical.js";
import type { Settings } from "./settings.js";
import { parseTime, present } from "./times.js";

export const MAX_RESULTS = 50;
export const MAX_RANGE_DAYS = 366;
const DAY_MS = 86_400_000;
/** Discovery older than this is redone before a tool uses it (the refresh job normally keeps it fresher). */
const ACCOUNT_MAX_AGE_MS = 10 * 60_000;
const NOTES_MAX = 500;
const REPEATS: Repeat[] = ["daily", "weekly", "monthly", "yearly"];

export interface ConnectionStatus {
  ok: boolean;
  checkedAt?: string;
  error?: string;
}

/** An event as tools return it. */
export interface EventView {
  id: string;
  title: string;
  calendar: string;
  start: string;
  end: string;
  allDay: boolean;
  when: string;
  recurring: boolean;
  readOnly: boolean;
  readOnlyReason?: string;
  location?: string;
  notes?: string;
}

/** A short description for previews, overlaps and the change log. */
export interface EventSummary {
  title: string;
  when: string;
  calendar?: string;
  location?: string;
}

export interface ServiceDeps {
  client: CalDavClient;
  settings: Settings;
  handles: EventHandles;
  zone: () => string;
  now: () => Date;
  /** Called after every successful write, so the agenda refreshes. */
  onWrite?: () => void;
}

export interface ListArgs {
  from?: string;
  to?: string;
  query?: string;
  calendar?: string;
}

export interface CreateArgs {
  title?: string;
  start?: string;
  end?: string;
  allDay?: boolean;
  location?: string;
  notes?: string;
  calendar?: string;
  repeat?: string;
  repeatUntil?: string;
}

/** An occurrence found in a calendar, with where it lives. */
export interface Found {
  calendar: CalendarInfo;
  object: CalendarObject;
  occurrence: Occurrence;
}

export class CalendarService {
  status: ConnectionStatus = { ok: false };
  private cached?: { account: Account; at: number };

  constructor(private readonly d: ServiceDeps) {}

  get zone(): string {
    return this.d.zone();
  }

  /** Runs an iCloud request and records whether it worked. */
  async icloud<T>(fn: () => Promise<T>): Promise<T> {
    try {
      const v = await fn();
      this.status = { ok: true, checkedAt: this.d.now().toISOString() };
      return v;
    } catch (e) {
      if (!(e instanceof InputError) && !(e instanceof ReadOnlyError)) {
        this.status = { ok: false, checkedAt: this.d.now().toISOString(), error: e instanceof Error ? e.message : String(e) };
      }
      throw e;
    }
  }

  /** The last discovery, if any (for the portal and the agenda). */
  get lastAccount(): Account | undefined {
    return this.cached?.account;
  }

  /** The account's calendars, rediscovered when `force` or when the cached discovery is old. */
  async account(force = false, signal?: AbortSignal): Promise<Account> {
    if (!force && this.cached && this.d.now().getTime() - this.cached.at < ACCOUNT_MAX_AGE_MS) return this.cached.account;
    const account = await this.icloud(() => this.d.client.discover(signal));
    this.cached = { account, at: this.d.now().getTime() };
    return account;
  }

  /** Marks a calendar read-only after iCloud refused a write to it. */
  markReadOnly(calendarId: string): void {
    const cal = this.cached?.account.calendars.find((c) => c.id === calendarId);
    if (cal) cal.writable = false;
  }

  /** Used calendars, optionally only the one named `name` (case-insensitive). */
  async usedCalendars(name?: string): Promise<CalendarInfo[]> {
    const used = this.d.settings.used((await this.account()).calendars);
    if (name === undefined) return used;
    const match = used.find((c) => c.name.toLowerCase() === name.trim().toLowerCase());
    if (!match) throw new InputError(`There is no calendar called "${name}". The calendars are: ${used.map((c) => `"${c.name}"`).join(", ") || "(none)"}.`);
    return [match];
  }

  /** Every occurrence in [from, to) in `calendars`, sorted by start. */
  async occurrences(calendars: CalendarInfo[], from: number, to: number, signal?: AbortSignal): Promise<Found[]> {
    const zone = this.zone;
    const perCalendar = await this.icloud(() => Promise.all(calendars.map(async (calendar) => ({ calendar, objects: await this.d.client.query(calendar.url, new Date(from), new Date(to), signal) }))));
    const out: Found[] = [];
    for (const { calendar, objects } of perCalendar) {
      for (const object of objects) {
        for (const occurrence of expand(parseIcs(object.ics), from, to, zone)) out.push({ calendar, object, occurrence });
      }
    }
    return out.sort((a, b) => a.occurrence.startMs - b.occurrence.startMs || a.occurrence.title.localeCompare(b.occurrence.title));
  }

  /** Why Friday can't change this event, if it can't. */
  readOnlyReason(f: Pick<Found, "calendar" | "occurrence">): string | undefined {
    if (!f.calendar.writable) return `"${f.calendar.name}" is a read-only calendar.`;
    const own = this.cached?.account.addresses ?? [];
    if (isInvitation(f.occurrence, own)) return `It is an invitation from ${f.occurrence.organizer}; change or decline it in the Calendar app.`;
    return undefined;
  }

  /** The tool view of an occurrence, with a fresh id. */
  view(f: Found): EventView {
    const o = f.occurrence;
    const ref: EventRef = { calendarId: f.calendar.id, objectUrl: f.object.url, etag: f.object.etag, occurrence: o };
    const reason = this.readOnlyReason(f);
    return {
      id: this.d.handles.idFor(ref),
      title: o.title,
      calendar: f.calendar.name,
      ...this.times(o),
      allDay: o.allDay,
      when: whenText(o, this.zone, this.d.now()),
      recurring: o.recurring,
      readOnly: !!reason,
      ...(reason ? { readOnlyReason: reason } : {}),
      ...(o.location ? { location: o.location } : {}),
      ...(o.notes ? { notes: o.notes.length > NOTES_MAX ? `${o.notes.slice(0, NOTES_MAX)}…` : o.notes } : {}),
    };
  }

  /** `start`/`end` as tools return them: local date-times, or dates with an inclusive end for all-day events. */
  times(s: Span): { start: string; end: string } {
    if (s.allDay) return { start: s.startDate!, end: addDays(s.endDate!, -1) };
    return { start: localIso(s.startMs, this.zone), end: localIso(s.endMs, this.zone) };
  }

  summary(s: Span & { title: string; location?: string }, calendar?: CalendarInfo): EventSummary {
    return { title: s.title, when: whenText(s, this.zone, this.d.now()), ...(calendar ? { calendar: calendar.name } : {}), ...(s.location ? { location: s.location } : {}) };
  }

  // ---- Listing -----------------------------------------------------------------------------------------------

  async list(args: ListArgs): Promise<Record<string, unknown>> {
    const zone = this.zone;
    const query = present(args.query);
    const fromArg = present(args.from), toArg = present(args.to);
    const today = localDate(this.d.now(), zone);
    const from = fromArg ? parseTime(fromArg, "from", zone) : ({ kind: "date", date: today } as const);
    const fromMs = from.kind === "date" ? startOfLocalDay(from.date, zone)!.getTime() : from.ms;
    let toMs: number;
    if (toArg) {
      const to = parseTime(toArg, "to", zone);
      toMs = to.kind === "date" ? endOfLocalDay(to.date, zone).getTime() : to.ms;
    } else {
      const days = query ? 365 : 7;
      toMs = from.kind === "date" ? startOfLocalDay(addDays(from.date, days), zone)!.getTime() : fromMs + days * DAY_MS;
    }
    if (toMs <= fromMs) throw new InputError("to must be after from.");
    if (toMs - fromMs > MAX_RANGE_DAYS * DAY_MS + 2 * 3_600_000) throw new InputError(`The range can be at most ${MAX_RANGE_DAYS} days; ask for a shorter one.`);

    const calendars = await this.usedCalendars(present(args.calendar));
    let found = await this.occurrences(calendars, fromMs, toMs);
    if (query) {
      const words = query.toLowerCase().split(/\s+/).filter(Boolean);
      found = found.filter(({ occurrence: o }) => {
        const hay = `${o.title}\n${o.location ?? ""}\n${o.notes ?? ""}`.toLowerCase();
        return words.every((w) => hay.includes(w));
      });
    }
    const events = found.slice(0, MAX_RESULTS).map((f) => this.view(f));
    return { events, ...(found.length > MAX_RESULTS ? { truncated: true, total: found.length } : {}) };
  }

  // ---- Creating ----------------------------------------------------------------------------------------------

  async create(args: CreateArgs, call: ToolCallContext = {}): Promise<Record<string, unknown>> {
    const zone = this.zone;
    const title = present(args.title);
    if (!title) throw new InputError("title is required.");
    const startArg = present(args.start);
    if (!startArg) throw new InputError("start is required.");
    const start = parseTime(startArg, "start", zone);
    const allDay = typeof args.allDay === "boolean" ? args.allDay : start.kind === "date";
    const span = this.newSpan(allDay, start, present(args.end));

    const repeatArg = present(args.repeat)?.toLowerCase();
    if (repeatArg && !REPEATS.includes(repeatArg as Repeat)) throw new InputError(`repeat must be one of ${REPEATS.join(", ")}.`);
    const untilArg = present(args.repeatUntil);
    if (untilArg && !repeatArg) throw new InputError("repeatUntil needs repeat.");
    if (untilArg) {
      const until = parseTime(untilArg, "repeatUntil", zone, "date");
      const firstDay = span.allDay ? span.startDate! : localDate(new Date(span.startMs), zone);
      if (until.kind === "date" && until.date < firstDay) throw new InputError("repeatUntil can't be before the start.");
    }

    const calendar = await this.targetCalendar(present(args.calendar));
    const uid = randomUUID().toUpperCase();
    const ics = buildEvent({ uid, title, span, location: present(args.location), notes: present(args.notes), repeat: repeatArg as Repeat | undefined, repeatUntil: untilArg, zone, now: this.d.now() });
    const url = new URL(`${uid}.ics`, calendar.url).toString();
    const etag = await this.write(calendar, () => this.d.client.put(url, ics, null));
    const object: CalendarObject = { url, etag, ics };
    const [occurrence] = expand(parseIcs(ics), span.startMs, Math.max(span.endMs, span.startMs + 1), zone);
    const created = this.view({ calendar, object, occurrence });
    this.afterWrite({ action: "create", calendar, object, before: null, title, summary: this.summary(occurrence, calendar), call });
    const overlaps = await this.overlaps(span, url);
    return {
      created,
      overlaps,
      say: `Created "${title}" on ${created.when} in ${calendar.name}.` + (overlaps.length ? ` It overlaps ${overlaps.map((o) => `"${o.title}" (${o.when})`).join(", ")}.` : ""),
    };
  }

  /** The span of a new or moved event from tool inputs, with the default durations. */
  newSpan(allDay: boolean, start: ReturnType<typeof parseTime>, endArg: string | undefined): Span {
    const zone = this.zone;
    if (allDay) {
      if (start.kind !== "date") throw new InputError("An all-day event takes dates: give start as YYYY-MM-DD.");
      let last = start.date;
      if (endArg) {
        const end = parseTime(endArg, "end", zone, "date");
        if (end.kind === "date") last = end.date;
        if (last < start.date) throw new InputError("end can't be before start.");
      }
      const endDate = addDays(last, 1);
      return { allDay: true, startDate: start.date, endDate, startMs: startOfLocalDay(start.date, zone)!.getTime(), endMs: startOfLocalDay(endDate, zone)!.getTime() };
    }
    if (start.kind !== "instant") throw new InputError("A timed event takes a date-time: give start like 2026-10-08T15:00, or set allDay.");
    let endMs = start.ms + 3_600_000;
    if (endArg) {
      const end = parseTime(endArg, "end", zone, "instant");
      if (end.kind === "instant") endMs = end.ms;
      if (endMs < start.ms) throw new InputError("end can't be before start.");
    }
    return { allDay: false, startMs: start.ms, endMs };
  }

  /** The calendar new events go to: the named one, or the default. */
  async targetCalendar(name: string | undefined): Promise<CalendarInfo> {
    if (name !== undefined) {
      const [cal] = await this.usedCalendars(name);
      if (!cal.writable) throw new ReadOnlyError(`"${cal.name}" is a read-only calendar, so nothing was created there.`);
      return cal;
    }
    const cal = this.d.settings.defaultCalendar((await this.account()).calendars);
    if (!cal) throw new ReadOnlyError("There is no writable calendar to add events to (check the calendars at /m/calendar in the portal).");
    return cal;
  }

  /** Timed events in used calendars overlapping `span`, except the object at `exceptUrl`. */
  async overlaps(span: Span, exceptUrl?: string): Promise<EventSummary[]> {
    if (span.endMs <= span.startMs) return [];
    try {
      const found = await this.occurrences(await this.usedCalendars(), span.startMs, span.endMs);
      return found.filter((f) => !f.occurrence.allDay && f.object.url !== exceptUrl).map((f) => this.summary(f.occurrence, f.calendar));
    } catch (e) {
      // The write already happened; a failed overlap check must not turn it into an error.
      if (e instanceof UpstreamError) return [];
      throw e;
    }
  }

  /** A write to `calendar`; a 403 marks the calendar read-only. */
  async write<T>(calendar: CalendarInfo, fn: () => Promise<T>): Promise<T> {
    try {
      return await this.icloud(fn);
    } catch (e) {
      if (e instanceof ReadOnlyError) this.markReadOnly(calendar.id);
      throw e;
    }
  }

  /** Bookkeeping after a successful write. */
  afterWrite(_change: { action: "create" | "update" | "delete"; calendar: CalendarInfo; object: CalendarObject; before: CalendarObject | null; title: string; summary: EventSummary; call: ToolCallContext }): void {
    this.d.onWrite?.();
  }
}
