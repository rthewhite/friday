/**
 * Today's and tomorrow's agenda in the prompt (design D7). The `calendar/refresh` job polls the intake for the Work
 * calendar and fetches three local days (so the midnight rollover still has a full tomorrow) for every used iCloud
 * calendar; each source fails on its own. `render` takes the Work events from the stored snapshot, filters by
 * `inAgenda` and works out "today" when the prompt is built, from memory only, as prompt providers must.
 */
import { localDate, startOfLocalDay } from "@friday/sdk";
import { addDays, wallClock } from "./format.js";
import type { Occurrence } from "./ical.js";
import type { CalendarService } from "./service.js";
import type { Settings } from "./settings.js";
import { WORK_CALENDAR_ID } from "./work.js";

export const REFRESH_EVERY_MS = 5 * 60_000;
export const STALE_AFTER_MS = 15 * 60_000;
export const AGENDA_MAX_CHARS = 2000;
const WINDOW_DAYS = 3;

interface Cached {
  fetchedAt: number;
  events: { calendarId: string; occurrence: Occurrence }[];
}

const DAY_LONG = new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
const dayLong = (date: string) => {
  const [y, m, d] = date.split("-").map(Number);
  return DAY_LONG.format(new Date(Date.UTC(y, m - 1, d))).replace(",", "");
};
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export class Agenda {
  private cache?: Cached;

  constructor(private readonly service: CalendarService, private readonly settings: Settings, private readonly now: () => Date) {}

  /** When the iCloud events were last fetched. */
  get fetchedAt(): Date | undefined {
    return this.cache ? new Date(this.cache.fetchedAt) : undefined;
  }

  /**
   * Polls the intake and fetches three local days of iCloud events, each when configured and each on its own:
   * a failing source keeps what it had. Throws only when every configured source failed.
   */
  async refresh(signal?: AbortSignal): Promise<{ summary: string }> {
    const work = this.service.work;
    // In parallel, so a slow iCloud can't use up the job's time before the intake is polled.
    const runs: { label: string; run: Promise<string> }[] = [];
    if (this.service.icloudConfigured) runs.push({ label: "iCloud", run: this.refreshICloud(signal) });
    if (work) {
      runs.push({
        label: "work",
        run: work.poll(signal).then(() => {
          const s = work.snapshot;
          return s ? `work: ${plural(s.items.length, "event")} (received ${wallClock(Date.parse(s.receivedAt), this.service.zone).time})` : "work: nothing received yet";
        }),
      });
    }
    const results = await Promise.allSettled(runs.map((r) => r.run));
    const parts = results.map((r, i) => (r.status === "fulfilled" ? r.value : `${runs[i].label} failed: ${message(r.reason)}`));
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    if (runs.length && failed.length === runs.length) throw failed.length === 1 ? failed[0].reason : new Error(parts.join("; "));
    return { summary: parts.join("; ") };
  }

  /** Rediscovers the iCloud calendars and caches three local days of their events. Keeps the old cache when it fails. */
  private async refreshICloud(signal?: AbortSignal): Promise<string> {
    const zone = this.service.zone;
    const account = await this.service.account(true, signal);
    if (account.icloudError) throw account.icloudError;
    const calendars = this.settings.used(account.calendars).filter((c) => c.source !== "intake");
    const today = localDate(this.now(), zone);
    const from = startOfLocalDay(today, zone)!.getTime();
    const to = startOfLocalDay(addDays(today, WINDOW_DAYS), zone)!.getTime();
    const found = await this.service.occurrences(calendars, from, to, signal);
    this.cache = { fetchedAt: this.now().getTime(), events: found.map((f) => ({ calendarId: f.calendar.id, occurrence: f.occurrence })) };
    return `${plural(found.length, "event")} in ${plural(calendars.length, "calendar")}`;
  }

  /** The prompt section, built from the iCloud cache and the stored work snapshot. */
  render(): string {
    const zone = this.service.zone;
    const head = "## Calendar";
    const icloud = this.service.icloudConfigured;
    const work = this.service.work;
    const now = this.now();
    const unavailable: string[] = [];
    if (icloud && !this.cache) {
      unavailable.push("The user's iCloud calendars are unavailable right now (iCloud could not be reached), so don't assume they are free. calendar_list_events tries again.");
    }
    if (work && !work.snapshot) {
      unavailable.push("The user's Work calendar (Outlook) is unavailable right now (no copy has arrived yet), so don't assume they are free at work.");
    }
    if (!(icloud && this.cache) && !work?.snapshot) return [head, ...unavailable].join("\n");

    const today = localDate(now, zone);
    const inAgenda = (id: string) => {
      const s = this.settings.of(id);
      return s.use && s.inAgenda;
    };
    const shown = this.service.knownCalendars().filter((c) => inAgenda(c.id));
    const names = new Map(shown.map((c) => [c.id, c.name]));
    const label = shown.length > 1;
    const windowStart = startOfLocalDay(today, zone)!.getTime();
    const windowEnd = startOfLocalDay(addDays(today, 2), zone)!.getTime();
    const visible = [
      ...(icloud && this.cache ? this.cache.events : []),
      ...(work ? work.occurrences(windowStart, windowEnd, zone).map((occurrence) => ({ calendarId: WORK_CALENDAR_ID, occurrence })) : []),
    ].filter((e) => inAgenda(e.calendarId));

    const lines: { text: string; event: boolean }[] = [
      { text: `${head}\nThe user's calendars for today and tomorrow (times in ${zone}). For other days, or to change an event, use the calendar tools.`, event: false },
      ...unavailable.map((text) => ({ text, event: false })),
    ];
    for (const [dayName, date] of [["Today", today], ["Tomorrow", addDays(today, 1)]] as const) {
      lines.push({ text: `${dayName}, ${dayLong(date)}:`, event: false });
      const start = startOfLocalDay(date, zone)!.getTime();
      const end = startOfLocalDay(addDays(date, 1), zone)!.getTime();
      const day = visible
        .filter(({ occurrence: o }) => (o.endMs > o.startMs ? o.startMs < end && o.endMs > start : o.startMs >= start && o.startMs < end))
        .sort((a, b) => Number(b.occurrence.allDay) - Number(a.occurrence.allDay) || a.occurrence.startMs - b.occurrence.startMs || a.occurrence.title.localeCompare(b.occurrence.title));
      if (!day.length) lines.push({ text: "- nothing planned", event: false });
      for (const { calendarId, occurrence: o } of day) {
        const name = label ? names.get(calendarId) : undefined;
        lines.push({ text: `- ${this.timeOf(o, start, end)} ${o.title}${o.location ? ` (${o.location})` : ""}${o.status ? ` (${o.status})` : ""}${name ? ` [${name}]` : ""}`, event: true });
      }
    }
    if (icloud && this.cache && now.getTime() - this.cache.fetchedAt > STALE_AFTER_MS) {
      lines.push({ text: `(Fetched at ${this.at(this.cache.fetchedAt, today)}; iCloud hasn't answered since, so this may be out of date.)`, event: false });
    }
    if (work?.snapshot && work.stale()) {
      lines.push({ text: `(The Work calendar was last updated at ${this.at(Date.parse(work.snapshot.receivedAt), today)}, so it may be out of date.)`, event: false });
    }
    return cut(lines);
  }

  /** "10:00", or "10:00 on Friday 2 October" for another day. */
  private at(ms: number, today: string): string {
    const w = wallClock(ms, this.service.zone);
    return w.date === today ? w.time : `${w.time} on ${dayLong(w.date)}`;
  }

  private timeOf(o: Occurrence, dayStart: number, dayEnd: number): string {
    const zone = this.service.zone;
    if (o.allDay || (o.startMs <= dayStart && o.endMs >= dayEnd)) return "all day:";
    const a = wallClock(o.startMs, zone).time, b = wallClock(o.endMs, zone).time;
    if (o.startMs < dayStart) return `until ${b}:`;
    if (o.endMs > dayEnd) return `from ${a}:`;
    return o.endMs > o.startMs ? `${a}-${b}:` : `${a}:`;
  }
}

/** Joins the lines, dropping event lines from the end until it fits, and says how many were left out. */
function cut(lines: { text: string; event: boolean }[]): string {
  const join = (ls: { text: string }[]) => ls.map((l) => l.text).join("\n");
  let text = join(lines);
  if (text.length <= AGENDA_MAX_CHARS) return text;
  const kept = [...lines];
  let dropped = 0;
  const note = () => `(${dropped} more event${dropped === 1 ? "" : "s"} left out; use calendar_list_events.)`;
  while (kept.some((l) => l.event) && join(kept).length + note().length + 1 > AGENDA_MAX_CHARS) {
    const i = kept.map((l) => l.event).lastIndexOf(true);
    kept.splice(i, 1);
    dropped++;
  }
  text = `${join(kept)}\n${note()}`;
  return text.length <= AGENDA_MAX_CHARS ? text : text.slice(0, AGENDA_MAX_CHARS);
}
