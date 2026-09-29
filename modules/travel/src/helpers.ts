import type { ResolvedPlace } from "./types.js";

/** Matches "52.379, 4.899" — a bare coordinate pair, with or without spaces. */
const COORDINATE_PAIR = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/;

/**
 * Turns a "lat,lon" string into a place directly, skipping the TomTom lookup.
 * Returns null for anything that is not a coordinate pair in valid ranges, which
 * the caller treats as "this needs resolving".
 */
export function parseCoordinates(input: string): ResolvedPlace | null {
  const match = COORDINATE_PAIR.exec(input);
  if (!match) return null;

  const lat = Number(match[1]);
  const lon = Number(match[2]);
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;

  return { name: `${lat},${lon}`, lat, lon };
}

export type TimeArgsResult =
  | { ok: true; departAt?: string; arriveAt?: string }
  | { ok: false; message: string };

export const DEFAULT_TIME_ZONE = "Europe/Amsterdam";

/** The zone to read offset-less times in: `zone` when it is a valid IANA zone, else the default. */
export function resolveTimeZone(zone: string | undefined): { zone: string; valid: boolean } {
  if (!zone) return { zone: DEFAULT_TIME_ZONE, valid: true };
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return { zone, valid: true };
  } catch {
    return { zone: DEFAULT_TIME_ZONE, valid: false };
  }
}

/**
 * Validates the departure/arrival arguments before anything is spent on a
 * request. TomTom takes only one of the two, and a past departAt would otherwise
 * be silently answered as "now" — which looks like a correct answer to a
 * question nobody asked.
 *
 * `timeZone` is the household's zone (FRIDAY_TIMEZONE): a time without an offset
 * means wall-clock time there, not in the server's zone (the container runs in UTC).
 */
export function validateTimeArgs(
  args: { departAt?: string; arriveAt?: string },
  timeZone: string = DEFAULT_TIME_ZONE,
  now: number = Date.now(),
): TimeArgsResult {
  const { departAt, arriveAt } = args;

  if (departAt && arriveAt) {
    return {
      ok: false,
      message: "Give either departAt or arriveAt, not both — the one you omit is what gets calculated.",
    };
  }

  if (departAt !== undefined) {
    const parsed = toRfc3339(departAt, timeZone);
    if (!parsed) {
      return { ok: false, message: `departAt is not a valid timestamp: "${departAt}".` };
    }
    if (parsed.instant < now) {
      return {
        ok: false,
        message: `departAt "${departAt}" is in the past. Omit it to route for right now.`,
      };
    }
    return { ok: true, departAt: parsed.value };
  }

  if (arriveAt !== undefined) {
    const parsed = toRfc3339(arriveAt, timeZone);
    if (!parsed) {
      return { ok: false, message: `arriveAt is not a valid timestamp: "${arriveAt}".` };
    }
    return { ok: true, arriveAt: parsed.value };
  }

  return { ok: true };
}

/** "2026-10-01T08:00" or "2026-10-01 08:00:00.000": an ISO 8601 date-time without an offset. */
const LOCAL_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/;

/**
 * TomTom wants RFC 3339. A value that already carries an offset is passed
 * through untouched so the caller's intended zone survives; a local date-time
 * is given `timeZone`'s offset at that moment. Anything else is not a timestamp.
 */
function toRfc3339(original: string, timeZone: string): { value: string; instant: number } | null {
  const value = original.trim();
  if (hasExplicitOffset(value)) {
    const instant = Date.parse(value);
    return Number.isNaN(instant) ? null : { value, instant };
  }

  const m = LOCAL_DATE_TIME.exec(value);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = [m[1], m[2], m[3], m[4], m[5], m[6] ?? "00"].map(Number);
  const wallClock = Date.UTC(y, mo - 1, d, h, mi, s);
  // Date.UTC rolls 2026-02-30 over into March; a date that does not round-trip is not a date.
  const check = new Date(wallClock);
  if (check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d || check.getUTCHours() !== h || check.getUTCMinutes() !== mi || check.getUTCSeconds() !== s) {
    return null;
  }

  // The offset depends on the instant, which depends on the offset: guess with the
  // wall-clock time read as UTC, then correct once in case that crossed a DST change.
  const offset = zoneOffsetMinutes(timeZone, wallClock - zoneOffsetMinutes(timeZone, wallClock) * 60_000);

  const date = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] ?? "00"}`;
  return { value: date + formatOffset(offset), instant: wallClock - offset * 60_000 };
}

function hasExplicitOffset(value: string): boolean {
  return /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value);
}

/** Minutes east of UTC for `timeZone` at `instant`, e.g. 120 for Amsterdam in summer. */
function zoneOffsetMinutes(timeZone: string, instant: number): number {
  const name = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" })
    .formatToParts(instant)
    .find((p) => p.type === "timeZoneName")?.value;
  // "GMT+02:00", or plain "GMT" for UTC itself.
  const m = /GMT([+-])(\d{2}):?(\d{2})?/.exec(name ?? "");
  if (!m) return 0;
  return (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0));
}

function formatOffset(minutes: number): string {
  if (minutes === 0) return "Z";
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

/**
 * Speech-friendly duration. The model reads this out instead of dividing 4340 by
 * 60 mid-sentence and rounding it differently every time.
 */
export function formatDuration(seconds: number): string {
  const totalMinutes = Math.round(seconds / 60);
  if (totalMinutes <= 0) return "less than a minute";

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours === 0) return `${minutes} min`;

  const hourPart = `${hours} ${hours === 1 ? "hour" : "hours"}`;
  return minutes === 0 ? hourPart : `${hourPart} ${minutes} min`;
}
