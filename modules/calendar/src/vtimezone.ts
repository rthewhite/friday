/**
 * A VTIMEZONE for an IANA zone, built from Intl so new events can carry `TZID=<FRIDAY_TIMEZONE>` (design D2).
 * Yearly rules (`BYMONTH`/`BYDAY`) are derived from one year's transitions when the next year follows the same
 * rule, as it does for the EU and US; otherwise the transitions are listed one by one for a generous span.
 */
import { offsetMinutes } from "@friday/sdk";

const DAY_MS = 86_400_000;
const WEEKDAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

interface Transition {
  /** Instant of the change. */
  at: number;
  from: number;
  to: number;
}

/** Offset changes in [Jan 1 `fromYear`, Jan 1 `toYear + 1`), to the minute. */
export function transitions(zone: string, fromYear: number, toYear: number): Transition[] {
  const out: Transition[] = [];
  const end = Date.UTC(toYear + 1, 0, 1);
  let t = Date.UTC(fromYear, 0, 1);
  let off = offsetMinutes(zone, t);
  while (t < end) {
    const next = t + DAY_MS;
    const nextOff = offsetMinutes(zone, next);
    if (nextOff !== off) {
      let lo = t, hi = next;
      while (hi - lo > 60_000) {
        const mid = Math.floor((lo + hi) / 2 / 60_000) * 60_000;
        if (offsetMinutes(zone, mid) === off) lo = mid;
        else hi = mid;
      }
      out.push({ at: hi, from: off, to: nextOff });
      off = nextOff;
    }
    t = next;
  }
  return out;
}

const pad = (n: number, w = 2) => String(Math.abs(n)).padStart(w, "0");
const offsetText = (min: number) => `${min < 0 ? "-" : "+"}${pad(Math.floor(Math.abs(min) / 60))}${pad(Math.abs(min) % 60)}`;

/** The local wall-clock of a transition, in the offset before it, as `YYYYMMDDTHHMMSS`, plus its date parts. */
function onset(tr: Transition) {
  const d = new Date(tr.at + tr.from * 60_000);
  const parts = { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), wd: d.getUTCDay(), hh: d.getUTCHours(), mm: d.getUTCMinutes() };
  return { ...parts, stamp: `${parts.y}${pad(parts.m)}${pad(parts.d)}T${pad(parts.hh)}${pad(parts.mm)}00` };
}

const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** The `ord`th (1-4, or -1 for last) `weekday` of a month, as a day number. */
function nthWeekday(y: number, m: number, ord: number, weekday: number): number {
  if (ord === -1) {
    const last = daysInMonth(y, m);
    const lastWd = new Date(Date.UTC(y, m - 1, last)).getUTCDay();
    return last - ((lastWd - weekday + 7) % 7);
  }
  const firstWd = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  return 1 + ((weekday - firstWd + 7) % 7) + (ord - 1) * 7;
}

function observance(kind: "STANDARD" | "DAYLIGHT", dtstart: string, from: number, to: number, rrule?: string): string[] {
  return [`BEGIN:${kind}`, `TZOFFSETFROM:${offsetText(from)}`, `TZOFFSETTO:${offsetText(to)}`, `DTSTART:${dtstart}`, ...(rrule ? [`RRULE:${rrule}`] : []), `END:${kind}`];
}

/** VTIMEZONE lines for `zone`, valid for events from `year` on. */
export function vtimezoneLines(zone: string, year: number): string[] {
  const head = ["BEGIN:VTIMEZONE", `TZID:${zone}`];
  const thisYear = transitions(zone, year, year);
  const nextYear = transitions(zone, year + 1, year + 1);
  if (thisYear.length === 0 && nextYear.length === 0) {
    const off = offsetMinutes(zone, Date.UTC(year, 0, 1));
    return [...head, ...observance("STANDARD", "19700101T000000", off, off), "END:VTIMEZONE"];
  }
  // Yearly rules, when next year's transitions fall where this year's rule predicts.
  if (thisYear.length === nextYear.length && thisYear.length > 0) {
    const rules = thisYear.map((tr) => {
      const o = onset(tr);
      const ord = o.d + 7 > daysInMonth(o.y, o.m) ? -1 : Math.ceil(o.d / 7);
      return { tr, o, ord };
    });
    const holds = rules.every(({ o, ord }, i) => {
      const n = onset(nextYear[i]);
      return n.m === o.m && n.d === nthWeekday(o.y + 1, o.m, ord, o.wd) && n.hh === o.hh && n.mm === o.mm;
    });
    if (holds) {
      const lines = rules.flatMap(({ tr, o, ord }) => {
        // Start the rule a year early, so events early in `year` are covered too.
        const y = o.y - 1;
        const stamp = `${y}${pad(o.m)}${pad(nthWeekday(y, o.m, ord, o.wd))}T${pad(o.hh)}${pad(o.mm)}00`;
        return observance(tr.to > tr.from ? "DAYLIGHT" : "STANDARD", stamp, tr.from, tr.to, `FREQ=YEARLY;BYMONTH=${o.m};BYDAY=${ord}${WEEKDAYS[o.wd]}`);
      });
      return [...head, ...lines, "END:VTIMEZONE"];
    }
  }
  // Irregular zone: list the transitions themselves.
  const all = transitions(zone, year - 1, year + 30);
  const first = all[0];
  const lines = [
    ...observance("STANDARD", "19700101T000000", first.from, first.from),
    ...all.flatMap((tr) => observance(tr.to > tr.from ? "DAYLIGHT" : "STANDARD", onset(tr).stamp, tr.from, tr.to)),
  ];
  return [...head, ...lines, "END:VTIMEZONE"];
}
