/**
 * The household's time zone (FRIDAY_TIMEZONE), resolved the same way everywhere:
 * one default, one validity check, one fallback. Pure Intl, so remote modules can
 * use it too.
 */
import type { ModuleConfig } from "./module.js";

export const DEFAULT_TIME_ZONE = "Europe/Amsterdam";

/** `zone` when it is a valid IANA zone, else the default; an unset or blank zone is not an error. */
export function resolveTimeZone(zone: string | undefined): { zone: string; valid: boolean } {
  const z = zone?.trim();
  if (!z) return { zone: DEFAULT_TIME_ZONE, valid: true };
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: z });
    return { zone: z, valid: true };
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
