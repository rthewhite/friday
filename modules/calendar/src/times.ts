/** Tool time inputs: ISO 8601 date-times (offset-less ones in the household zone) or `YYYY-MM-DD` dates. */
import { parseDateTime, startOfLocalDay } from "@friday/sdk";
import { InputError } from "./errors.js";

export type TimeInput = { kind: "date"; date: string } | { kind: "instant"; ms: number };

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Models often send "" or null for an optional argument they mean to leave out. */
export function present(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

export function isDate(v: string): boolean {
  return DATE.test(v) && startOfLocalDay(v, "UTC") !== undefined;
}

/** A date or date-time; anything else is an error naming `name`. */
export function parseTime(value: string, name: string, zone: string, allow: "date" | "instant" | "either" = "either"): TimeInput {
  if (allow !== "instant" && isDate(value)) return { kind: "date", date: value };
  const p = parseDateTime(value, zone);
  if (p && allow !== "date") return { kind: "instant", ms: p.instant };
  const wanted = allow === "date" ? "a date (YYYY-MM-DD)" : allow === "instant" ? "an ISO 8601 date-time (e.g. 2026-10-08T15:00)" : "a date (YYYY-MM-DD) or an ISO 8601 date-time (e.g. 2026-10-08T15:00)";
  throw new InputError(`${name} must be ${wanted}, not "${value}".`);
}
