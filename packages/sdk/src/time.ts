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
  try {
    return { zone: new Intl.DateTimeFormat("en-US", { timeZone: z }).resolvedOptions().timeZone, valid: true };
  } catch {
    return { zone: DEFAULT_TIME_ZONE, valid: false };
  }
}

/** `YYYY-MM-DD` of `at` in `zone`. */
export function localDate(at: Date, zone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(at);
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

/** Minutes east of UTC for `zone` at `instant`, e.g. 120 for Amsterdam in summer. */
function offsetMinutes(zone: string, instant: number): number {
  const name = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "longOffset" })
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
