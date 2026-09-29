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
 * A past arriveAt is refused too: TomTom would answer it with a bare HTTP 400
 * after two geocodes have already been spent.
 *
 * `timeZone` is the household's zone (FRIDAY_TIMEZONE): a time without an offset
 * means wall-clock time there, not in the server's zone (the container runs in UTC).
 */
export function validateTimeArgs(
  args: { departAt?: string | null; arriveAt?: string | null },
  timeZone: string = DEFAULT_TIME_ZONE,
  now: number = Date.now(),
): TimeArgsResult {
  // Models often fill an optional argument with "" (or null) instead of leaving it out.
  const departAt = present(args.departAt);
  const arriveAt = present(args.arriveAt);

  if (departAt && arriveAt) {
    return {
      ok: false,
      message: "Give either departAt or arriveAt, not both — the one you omit is what gets calculated.",
    };
  }

  if (departAt) {
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

  if (arriveAt) {
    const parsed = toRfc3339(arriveAt, timeZone);
    if (!parsed) {
      return { ok: false, message: `arriveAt is not a valid timestamp: "${arriveAt}".` };
    }
    if (parsed.instant < now) {
      return { ok: false, message: `arriveAt "${arriveAt}" is in the past. Did you mean a later day?` };
    }
    return { ok: true, arriveAt: parsed.value };
  }

  return { ok: true };
}

function present(value: string | null | undefined): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * "2026-10-01T08:00", "2026-10-01 08:00:00.000", "2026-10-01T08:00:00+02:00", "…Z":
 * an ISO 8601 date-time with an optional RFC 3339 offset.
 */
const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/i;

/**
 * TomTom wants RFC 3339, written as `YYYY-MM-DDTHH:mm:ss` plus an offset. A value
 * that carries an offset keeps it, so the caller's intended zone survives; a local
 * date-time is given `timeZone`'s offset at that moment. Anything else, including
 * a date that does not exist, is not a timestamp. (Date.parse is not used: V8
 * accepts RFC 2822, "+0200" and 30 February.)
 */
function toRfc3339(value: string, timeZone: string): { value: string; instant: number } | null {
  const m = DATE_TIME.exec(value);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = [m[1], m[2], m[3], m[4], m[5], m[6] ?? "00"].map(Number);
  const wallClock = Date.UTC(y, mo - 1, d, h, mi, s);
  // Date.UTC rolls 2026-02-30 over into March; a date that does not round-trip is not a date.
  const check = new Date(wallClock);
  if (check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d || check.getUTCHours() !== h || check.getUTCMinutes() !== mi || check.getUTCSeconds() !== s) {
    return null;
  }

  let offset: number;
  let suffix: string;
  if (m[7]) {
    offset = parseOffset(m[7]);
    if (Number.isNaN(offset)) return null;
    suffix = m[7].toUpperCase();
  } else {
    // The offset depends on the instant, which depends on the offset: guess with the
    // wall-clock time read as UTC, then correct once in case that crossed a DST change.
    offset = zoneOffsetMinutes(timeZone, wallClock - zoneOffsetMinutes(timeZone, wallClock) * 60_000);
    suffix = formatOffset(offset);
  }

  const date = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] ?? "00"}`;
  return { value: date + suffix, instant: wallClock - offset * 60_000 };
}

/** "Z" or "±HH:MM" as minutes east of UTC; NaN when out of range. */
function parseOffset(offset: string): number {
  if (offset.toUpperCase() === "Z") return 0;
  const hours = Number(offset.slice(1, 3));
  const minutes = Number(offset.slice(4, 6));
  if (hours > 23 || minutes > 59) return NaN;
  return (offset[0] === "-" ? -1 : 1) * (hours * 60 + minutes);
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
