/** Times as tools return them: local ISO 8601 with the zone's offset, dates, and a short readable `when`. */
import { formatOffset, localDate, offsetMinutes, startOfLocalDay } from "@friday/sdk";

const formats = new Map<string, Intl.DateTimeFormat>();

/** Wall-clock parts of `ms` in `zone`. */
export function wallClock(ms: number, zone: string): { date: string; time: string; seconds: string } {
  let f = formats.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
    if (formats.size >= 64) formats.clear();
    formats.set(zone, f);
  }
  const parts = f.formatToParts(ms);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return { date: `${get("year")}-${get("month")}-${get("day")}`, time: `${get("hour")}:${get("minute")}`, seconds: get("second") };
}

/** `YYYY-MM-DDTHH:mm:ss±HH:MM` in `zone`. */
export function localIso(ms: number, zone: string): string {
  const w = wallClock(ms, zone);
  return `${w.date}T${w.time}:${w.seconds}${formatOffset(offsetMinutes(zone, ms))}`;
}

/** `YYYY-MM-DD` plus `days`. */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Start of the day after `date` in `zone`. */
export function endOfLocalDay(date: string, zone: string): Date {
  return startOfLocalDay(addDays(date, 1), zone)!;
}

const DAY = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
const DAY_YEAR = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

/** "Thu 8 Oct" (with the year when it isn't `thisYear`). */
export function dayLabel(date: string, thisYear?: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const f = thisYear && String(y) !== thisYear ? DAY_YEAR : DAY;
  return f.format(new Date(Date.UTC(y, m - 1, d))).replace(",", "");
}

export interface Span {
  allDay: boolean;
  startMs: number;
  endMs: number;
  /** All-day only: first day and the day after the last (exclusive), `YYYY-MM-DD`. */
  startDate?: string;
  endDate?: string;
}

/** "Thu 8 Oct, 15:00-16:00", "Thu 8 Oct 22:00 - Fri 9 Oct 01:00", "Thu 8 Oct, all day", "Thu 8 Oct - Fri 9 Oct, all day". */
export function whenText(s: Span, zone: string, now: Date): string {
  const thisYear = localDate(now, zone).slice(0, 4);
  if (s.allDay && s.startDate && s.endDate) {
    const last = addDays(s.endDate, -1);
    return last <= s.startDate ? `${dayLabel(s.startDate, thisYear)}, all day` : `${dayLabel(s.startDate, thisYear)} - ${dayLabel(last, thisYear)}, all day`;
  }
  const a = wallClock(s.startMs, zone), b = wallClock(s.endMs, zone);
  if (a.date === b.date || (b.time === "00:00" && addDays(a.date, 1) === b.date && s.endMs > s.startMs)) {
    return `${dayLabel(a.date, thisYear)}, ${a.time}-${b.time === "00:00" && a.date !== b.date ? "24:00" : b.time}`;
  }
  return `${dayLabel(a.date, thisYear)} ${a.time} - ${dayLabel(b.date, thisYear)} ${b.time}`;
}
