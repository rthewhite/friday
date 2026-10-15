/**
 * A time of day as the user said it ("07:30", optionally on a date) turned into the instant an alarm is due, in the
 * household zone. The model never does this sum: on 13 October it did, from a UTC clock, and woke nobody.
 */
import { localDate, offsetMinutes } from "@friday/sdk";

/** The furthest ahead an alarm may be set, in local days from today. */
export const MAX_ALARM_DAYS = 7;

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

// Intl formatters are costly to build and every alert in a tool result needs a few, so they're kept per zone.
const timeFormats = new Map<string, Intl.DateTimeFormat>();

/** `HH:MM` of `at` in `zone`, 24-hour. */
export function localTime(at: Date, zone: string): string {
  let f = timeFormats.get(zone);
  if (!f) {
    if (timeFormats.size >= 64) timeFormats.clear();
    f = new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    timeFormats.set(zone, f);
  }
  return f.format(at);
}

/** `date` (`YYYY-MM-DD`) moved by `days`. */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d) + days * DAY_MS).toISOString().slice(0, 10);
}

/** The instant `time` falls on `date` in `zone`: the earlier one when it occurs twice, undefined when it doesn't occur. */
export function wallClockInstant(date: string, time: string, zone: string): Date | undefined {
  return wallClockInstants(date, time, zone)[0];
}

/**
 * Every instant `time` falls on `date` in `zone`, earliest first: two in the hour the clock goes back to winter
 * time, none when the clock skips it (forward to summer time) or the date is not a real one.
 */
export function wallClockInstants(date: string, time: string, zone: string): Date[] {
  const d = DATE.exec(date), t = TIME.exec(time);
  if (!d || !t) return [];
  const wall = Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]), Number(t[1]), Number(t[2]));
  if (new Date(wall).toISOString().slice(0, 10) !== date) return [];
  // Every offset the zone has around that day is a candidate; the ones that read back as the same wall-clock time
  // are real, and there are two of them only in the hour the clock goes back.
  const offsets = new Set([offsetMinutes(zone, wall - DAY_MS), offsetMinutes(zone, wall), offsetMinutes(zone, wall + DAY_MS)]);
  return [...offsets]
    .map((o) => new Date(wall - o * 60_000))
    .filter((at) => localDate(at, zone) === date && localTime(at, zone) === time)
    .sort((a, b) => a.getTime() - b.getTime());
}

/**
 * When an alarm for `time` (and `date`, when given) is due: without a date the next time the clock shows `time`
 * after `now`, with one that time on that date, which must be ahead and at most MAX_ALARM_DAYS away. When the clock
 * shows it twice that day, the first one still ahead counts.
 */
export function alarmTime(time: unknown, date: unknown, now: Date, zone: string): { at: Date } | { error: string } {
  if (typeof time !== "string" || !TIME.test(time)) return { error: 'time must be a 24-hour time as HH:MM, e.g. "07:30"' };
  if (date !== undefined && (typeof date !== "string" || !DATE.test(date))) return { error: 'date must be YYYY-MM-DD, e.g. "2026-10-16"' };
  const today = localDate(now, zone);
  const skipped = (day: string) => ({ error: `${time} does not occur on ${day}: the clocks skip it for summer time; ask for another time` });
  const ahead = (day: string) => wallClockInstants(day, time, zone).find((at) => at > now);

  if (date === undefined) {
    const atToday = ahead(today);
    if (atToday) return { at: atToday };
    // Skipped today but still ahead on the clock: the user meant tonight, which has no such time.
    if (!wallClockInstants(today, time, zone).length && localTime(now, zone) < time) return skipped(today);
    const tomorrow = addDays(today, 1);
    const at = wallClockInstant(tomorrow, time, zone);
    return at ? { at } : skipped(tomorrow);
  }

  if (!wallClockInstant(date, "12:00", zone)) return { error: `${date} is not a date` };
  if (date < today) return { error: `${date} is in the past; today is ${today}` };
  if (date > addDays(today, MAX_ALARM_DAYS)) return { error: `alarms can be set at most ${MAX_ALARM_DAYS} days ahead; today is ${today}` };
  if (!wallClockInstants(date, time, zone).length) return skipped(date);
  const at = ahead(date);
  return at ? { at } : { error: `${time} on ${date} has already passed` };
}
