import { DEFAULT_TIME_ZONE, parseDateTime } from "@friday/sdk";
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
    const parsed = parseDateTime(departAt, timeZone);
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
    const parsed = parseDateTime(arriveAt, timeZone);
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
