/**
 * The household's time zone (FRIDAY_TIMEZONE), resolved the same way everywhere:
 * one default, one validity check, one fallback. Pure Intl, so remote modules can
 * use it too.
 */
import type { ModuleConfig } from "./module.js";

export const DEFAULT_TIME_ZONE = "Europe/Amsterdam";

/**
 * `zone` when it is a valid IANA zone, else the default; an unset or blank zone is not an error. A valid zone is
 * returned in Intl's own spelling, so "europe/amsterdam" and "Europe/Amsterdam" are the same zone.
 */
export function resolveTimeZone(zone: string | undefined): { zone: string; valid: boolean } {
  const z = zone?.trim();
  if (!z) return { zone: DEFAULT_TIME_ZONE, valid: true };
  return cached(resolved, z, () => {
    try {
      return { zone: new Intl.DateTimeFormat("en-US", { timeZone: z }).resolvedOptions().timeZone, valid: true };
    } catch {
      return { zone: DEFAULT_TIME_ZONE, valid: false };
    }
  });
}

// Intl.DateTimeFormat is costly to construct and these run per occurrence when calendars are expanded, so
// formatters and resolutions are kept per zone (bounded, in case of many distinct names).
const resolved = new Map<string, { zone: string; valid: boolean }>();
const dateFormats = new Map<string, Intl.DateTimeFormat>();
const offsetFormats = new Map<string, Intl.DateTimeFormat>();
function cached<T>(map: Map<string, T>, key: string, make: () => T): T {
  let v = map.get(key);
  if (v === undefined) {
    if (map.size >= 256) map.clear();
    v = make();
    map.set(key, v);
  }
  return v;
}

/** `YYYY-MM-DD` of `at` in `zone`. */
export function localDate(at: Date, zone: string): string {
  const parts = cached(dateFormats, zone, () => new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" })).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/**
 * The first instant of `date` (`YYYY-MM-DD`) in `zone`: local midnight, or where midnight is skipped by a DST
 * change, the first moment of that day. The next day's start ends the day, so 23- and 25-hour days come out
 * right. Undefined for anything that is not a real calendar date.
 */
export function startOfLocalDay(date: string, zone: string): Date | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return undefined;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const wallClock = Date.UTC(y, mo - 1, d);
  // Date.UTC rolls 2026-02-30 over into March; a date that does not round-trip is not a date.
  const check = new Date(wallClock);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return undefined;
  // The offset depends on the instant: guess with midnight read as UTC, then correct once for a DST change.
  let t = wallClock - offsetMinutes(zone, wallClock - offsetMinutes(zone, wallClock) * 60_000) * 60_000;
  while (localDate(new Date(t), zone) < date) t += 15 * 60_000;
  return new Date(t);
}

/**
 * "2026-10-01T08:00", "2026-10-01 08:00:00.000", "2026-10-01T08:00:00+02:00", "…Z":
 * an ISO 8601 date-time with an optional RFC 3339 offset.
 */
const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/i;

/**
 * Parses a date-time strictly, as `YYYY-MM-DDTHH:mm:ss` plus an offset, and its instant. A value that carries an
 * offset keeps it, so the caller's intended zone survives; a local date-time is read as wall-clock time in `zone`
 * and given that zone's offset at that moment. Anything else, including a date that does not exist, is null.
 * (Date.parse is not used: V8 accepts RFC 2822, "+0200" and 30 February.)
 */
export function parseDateTime(value: string, zone: string): { value: string; instant: number } | null {
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
    offset = offsetMinutes(zone, wallClock - offsetMinutes(zone, wallClock) * 60_000);
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

/** Minutes east of UTC as `Z` or `±HH:MM`. */
export function formatOffset(minutes: number): string {
  if (minutes === 0) return "Z";
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

/** Minutes east of UTC for `zone` at `instant`, e.g. 120 for Amsterdam in summer. */
export function offsetMinutes(zone: string, instant: number): number {
  const name = cached(offsetFormats, zone, () => new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "longOffset" }))
    .formatToParts(instant)
    .find((p) => p.type === "timeZoneName")?.value;
  // "GMT+02:00", or plain "GMT" for UTC itself.
  const m = /GMT([+-])(\d{2}):?(\d{2})?/.exec(name ?? "");
  if (!m) return 0;
  return (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0));
}

/**
 * A reader of FRIDAY_TIMEZONE for one module: resolves it on every call (so a value
 * saved later is picked up without a reload) and warns once per invalid value.
 * `householdTimeZone(ctx.config, (m) => ctx.log.warn(m))`.
 */
export function householdTimeZone(config: Pick<ModuleConfig, "get">, warn: (msg: string) => void): () => string {
  let warned: string | undefined;
  return () => {
    const configured = config.get("FRIDAY_TIMEZONE");
    const { zone, valid } = resolveTimeZone(configured);
    if (valid) {
      // Forget the last warning, so the same typo coming back later is reported again.
      warned = undefined;
    } else if (warned !== configured) {
      warned = configured;
      warn(`FRIDAY_TIMEZONE ${JSON.stringify(configured)} is not a valid zone; using ${zone}`);
    }
    return zone;
  };
}
