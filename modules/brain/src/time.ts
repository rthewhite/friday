/** Dates in the household's zone (FRIDAY_TIMEZONE). */
export const DEFAULT_TIMEZONE = "Europe/Amsterdam";

/** `YYYY-MM-DD` of `at` in `timeZone`. */
export function localDate(at: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** `localDate` in `zone`, falling back to the default zone (with a warning) when `zone` is not a valid IANA zone. */
export function safeLocalDate(at: Date, zone: string | undefined, warn: (msg: string) => void): string {
  const z = zone || DEFAULT_TIMEZONE;
  try {
    return localDate(at, z);
  } catch {
    warn(`FRIDAY_TIMEZONE ${JSON.stringify(z)} is not a valid zone; using ${DEFAULT_TIMEZONE}`);
    return localDate(at, DEFAULT_TIMEZONE);
  }
}
