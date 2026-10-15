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

/** `HH:MM` of `at` in `zone`, 24-hour. */
export function localTime(at: Date, zone: string): string {
  return at.toLocaleTimeString("en-GB", { timeZone: zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
}

/** `date` (`YYYY-MM-DD`) moved by `days`. */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d) + days * DAY_MS).toISOString().slice(0, 10);
}

/**
 * The instant `time` falls on `date` in `zone`: the earlier one when the clock passes it twice (back to winter time),
 * undefined when the clock skips it (forward to summer time) or the date is not a real one.
 */
export function wallClockInstant(date: string, time: string, zone: string): Date | undefined {
  const d = DATE.exec(date), t = TIME.exec(time);
  if (!d || !t) return undefined;
  const wall = Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]), Number(t[1]), Number(t[2]));
  if (new Date(wall).toISOString().slice(0, 10) !== date) return undefined;
  // Every offset the zone has around that day is a candidate; the ones that read back as the same wall-clock time
  // are real, and there are two of them only in the hour the clock goes back.
  const offsets = new Set([offsetMinutes(zone, wall - DAY_MS), offsetMinutes(zone, wall), offsetMinutes(zone, wall + DAY_MS)]);
  const real = [...offsets]
    .map((o) => new Date(wall - o * 60_000))
    .filter((at) => localDate(at, zone) === date && localTime(at, zone) === time)
    .sort((a, b) => a.getTime() - b.getTime());
  return real[0];
}

/**
 * When an alarm for `time` (and `date`, when given) is due: without a date the next time the clock shows `time`
 * after `now`, with one that time on that date, which must be ahead and at most MAX_ALARM_DAYS away.
 */
export function alarmTime(time: unknown, date: unknown, now: Date, zone: string): { at: Date } | { error: string } {
  if (typeof time !== "string" || !TIME.test(time)) return { error: 'time must be a 24-hour time as HH:MM, e.g. "07:30"' };
  if (date !== undefined && (typeof date !== "string" || !DATE.test(date))) return { error: 'date must be YYYY-MM-DD, e.g. "2026-10-16"' };
  const today = localDate(now, zone);
  const skipped = (day: string) => ({ error: `${time} does not occur on ${day}: the clocks skip it for summer time. Ask for another time.` });

  if (date === undefined) {
    const atToday = wallClockInstant(today, time, zone);
    if (atToday && atToday > now) return { at: atToday };
    // Skipped today but still ahead on the clock: the user meant tonight, which has no such time.
    if (!atToday && localTime(now, zone) < time) return skipped(today);
    const tomorrow = addDays(today, 1);
    const at = wallClockInstant(tomorrow, time, zone);
    return at ? { at } : skipped(tomorrow);
  }

  if (!wallClockInstant(date, "12:00", zone)) return { error: `${date} is not a date` };
  if (date < today) return { error: `${date} is in the past; today is ${today}` };
  if (date > addDays(today, MAX_ALARM_DAYS)) return { error: `alarms can be set at most ${MAX_ALARM_DAYS} days ahead; today is ${today}` };
  const at = wallClockInstant(date, time, zone);
  if (!at) return skipped(date);
  if (at <= now) return { error: `${time} on ${date} has already passed` };
  return { at };
}
