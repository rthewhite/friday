/**
 * Today's and tomorrow's agenda in the prompt (design D7). The `calendar/refresh` job fetches three local days
 * (so the midnight rollover still has a full tomorrow) for every used calendar; `render` filters by `inAgenda`
 * and works out "today" when the prompt is built, from memory only, as prompt providers must.
 */
import { localDate, startOfLocalDay } from "@friday/sdk";
import { addDays, wallClock } from "./format.js";
import type { Occurrence } from "./ical.js";
import type { CalendarService } from "./service.js";
import type { Settings } from "./settings.js";

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

export class Agenda {
  private cache?: Cached;

  constructor(private readonly service: CalendarService, private readonly settings: Settings, private readonly now: () => Date) {}

  get fetchedAt(): Date | undefined {
    return this.cache ? new Date(this.cache.fetchedAt) : undefined;
  }

  /** Rediscovers calendars and fetches three local days for the used ones. Keeps the old cache when it fails. */
  async refresh(signal?: AbortSignal): Promise<{ events: number; calendars: number }> {
    const zone = this.service.zone;
    const account = await this.service.account(true, signal);
    const calendars = this.settings.used(account.calendars);
    const today = localDate(this.now(), zone);
    const from = startOfLocalDay(today, zone)!.getTime();
    const to = startOfLocalDay(addDays(today, WINDOW_DAYS), zone)!.getTime();
    const found = await this.service.occurrences(calendars, from, to, signal);
    this.cache = { fetchedAt: this.now().getTime(), events: found.map((f) => ({ calendarId: f.calendar.id, occurrence: f.occurrence })) };
    return { events: found.length, calendars: calendars.length };
  }

  /** The prompt section, built from the cache. */
  render(): string {
    const zone = this.service.zone;
    const head = "## Calendar";
    if (!this.cache) {
      return `${head}\nThe user's calendar is unavailable right now (iCloud could not be reached), so don't assume they are free. calendar_list_events tries again.`;
    }
    const now = this.now();
    const today = localDate(now, zone);
    const lines: { text: string; event: boolean }[] = [
      { text: `${head}\nThe user's iCloud calendar for today and tomorrow (times in ${zone}). For other days, or to change an event, use the calendar tools.`, event: false },
    ];
    const visible = this.cache.events.filter((e) => {
      const s = this.settings.of(e.calendarId);
      return s.use && s.inAgenda;
    });
    for (const [label, date] of [["Today", today], ["Tomorrow", addDays(today, 1)]] as const) {
      lines.push({ text: `${label}, ${dayLong(date)}:`, event: false });
      const start = startOfLocalDay(date, zone)!.getTime();
      const end = startOfLocalDay(addDays(date, 1), zone)!.getTime();
      const day = visible
        .map((e) => e.occurrence)
        .filter((o) => (o.endMs > o.startMs ? o.startMs < end && o.endMs > start : o.startMs >= start && o.startMs < end))
        .sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.startMs - b.startMs || a.title.localeCompare(b.title));
      if (!day.length) lines.push({ text: "- nothing planned", event: false });
      for (const o of day) lines.push({ text: `- ${this.timeOf(o, start, end)} ${o.title}${o.location ? ` (${o.location})` : ""}`, event: true });
    }
    if (now.getTime() - this.cache.fetchedAt > STALE_AFTER_MS) {
      const at = wallClock(this.cache.fetchedAt, zone);
      const on = at.date === today ? "" : ` on ${dayLong(at.date)}`;
      lines.push({ text: `(Fetched at ${at.time}${on}; iCloud hasn't answered since, so this may be out of date.)`, event: false });
    }
    return cut(lines);
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
