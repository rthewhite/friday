import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_TIME_ZONE, formatOffset, householdTimeZone, localDate, offsetMinutes, parseDateTime, resolveTimeZone, startOfLocalDay } from "../src/index.js";

test("parseDateTime reads an offset-less date-time as wall-clock time in the zone", () => {
  const r = parseDateTime("2026-10-08T15:00", "Europe/Amsterdam");
  assert.equal(r?.value, "2026-10-08T15:00:00+02:00");
  assert.equal(new Date(r!.instant).toISOString(), "2026-10-08T13:00:00.000Z");
});

test("parseDateTime keeps the value's own offset", () => {
  assert.equal(parseDateTime("2026-10-08T15:00:00-05:00", "Europe/Amsterdam")?.value, "2026-10-08T15:00:00-05:00");
  assert.equal(parseDateTime("2026-10-08T15:00:00z", "Europe/Amsterdam")?.value, "2026-10-08T15:00:00Z");
});

test("parseDateTime uses the offset on the far side of a DST change and accepts a space and fractions", () => {
  // Amsterdam leaves summer time on 25 October 2026 at 03:00.
  assert.equal(parseDateTime("2026-10-24 09:00", "Europe/Amsterdam")?.value, "2026-10-24T09:00:00+02:00");
  assert.equal(parseDateTime("2026-10-26 09:00:30.250", "Europe/Amsterdam")?.value, "2026-10-26T09:00:30+01:00");
  assert.equal(parseDateTime("2026-01-05T09:00", "UTC")?.value, "2026-01-05T09:00:00Z");
});

test("parseDateTime rejects anything that is not a real ISO 8601 date-time", () => {
  for (const v of ["2026-02-30T10:00", "Thu, 08 Oct 2026 15:00:00 +0200", "2026-10-08T15:00+0200", "2026-10-08", "2026-10-08T25:00", "tomorrow", "2026-10-08T15:00+24:00"]) {
    assert.equal(parseDateTime(v, "Europe/Amsterdam"), null, v);
  }
});

test("offsetMinutes and formatOffset agree on summer, winter and negative zones", () => {
  assert.equal(offsetMinutes("Europe/Amsterdam", Date.UTC(2026, 6, 1)), 120);
  assert.equal(offsetMinutes("Europe/Amsterdam", Date.UTC(2026, 0, 1)), 60);
  assert.equal(formatOffset(offsetMinutes("America/New_York", Date.UTC(2026, 0, 1))), "-05:00");
  assert.equal(formatOffset(0), "Z");
});

/** A reader over a mutable config, recording its warnings. */
function reader(env: Record<string, string | undefined>) {
  const warnings: string[] = [];
  const zone = householdTimeZone({ get: (k) => env[k] }, (m) => warnings.push(m));
  return { zone, warnings };
}

test("the default zone is Europe/Amsterdam", () => {
  assert.equal(DEFAULT_TIME_ZONE, "Europe/Amsterdam");
});

test("resolveTimeZone keeps a valid zone, defaults an unset or blank one, and flags an invalid one", () => {
  assert.deepEqual(resolveTimeZone("America/New_York"), { zone: "America/New_York", valid: true });
  assert.deepEqual(resolveTimeZone(undefined), { zone: "Europe/Amsterdam", valid: true });
  assert.deepEqual(resolveTimeZone("  "), { zone: "Europe/Amsterdam", valid: true });
  assert.deepEqual(resolveTimeZone("Mars/Olympus"), { zone: "Europe/Amsterdam", valid: false });
});

test("resolveTimeZone returns a valid zone in Intl's spelling, so case differences are the same zone", () => {
  assert.deepEqual(resolveTimeZone("europe/amsterdam"), { zone: "Europe/Amsterdam", valid: true });
  assert.deepEqual(resolveTimeZone(" AMERICA/NEW_YORK "), { zone: "America/New_York", valid: true });
});

test("the reader returns a valid configured zone without warning", () => {
  const { zone, warnings } = reader({ FRIDAY_TIMEZONE: "Asia/Tokyo" });
  assert.equal(zone(), "Asia/Tokyo");
  assert.deepEqual(warnings, []);
});

test("the reader defaults an unset or blank zone without warning", () => {
  const unset = reader({});
  const blank = reader({ FRIDAY_TIMEZONE: "" });
  assert.equal(unset.zone(), "Europe/Amsterdam");
  assert.equal(blank.zone(), "Europe/Amsterdam");
  assert.deepEqual([...unset.warnings, ...blank.warnings], []);
});

test("an invalid zone falls back on every call and warns once, naming both zones", () => {
  const { zone, warnings } = reader({ FRIDAY_TIMEZONE: "Mars/Olympus" });
  assert.deepEqual([zone(), zone(), zone()], ["Europe/Amsterdam", "Europe/Amsterdam", "Europe/Amsterdam"]);
  assert.deepEqual(warnings, ['FRIDAY_TIMEZONE "Mars/Olympus" is not a valid zone; using Europe/Amsterdam']);
});

test("the reader picks up a zone changed between calls, and warns again for a new invalid value", () => {
  const env: Record<string, string | undefined> = { FRIDAY_TIMEZONE: "Europe/Amsterdam" };
  const { zone, warnings } = reader(env);
  assert.equal(zone(), "Europe/Amsterdam");
  env.FRIDAY_TIMEZONE = "America/New_York";
  assert.equal(zone(), "America/New_York");
  env.FRIDAY_TIMEZONE = "Mars/Olympus";
  zone();
  env.FRIDAY_TIMEZONE = "Venus/Maxwell";
  zone();
  zone();
  assert.equal(warnings.length, 2);
  assert.match(warnings[1], /Venus\/Maxwell/);
});

test("the same invalid value is reported again after the zone was fixed in between", () => {
  const env: Record<string, string | undefined> = { FRIDAY_TIMEZONE: "Europe/Amsterdm" };
  const { zone, warnings } = reader(env);
  zone();
  env.FRIDAY_TIMEZONE = "Europe/Amsterdam";
  zone();
  env.FRIDAY_TIMEZONE = "Europe/Amsterdm";
  zone();
  assert.equal(warnings.length, 2);
});

test("localDate is the calendar date in the zone, not in UTC", () => {
  assert.equal(localDate(new Date("2026-09-28T23:30:00Z"), "Europe/Amsterdam"), "2026-09-29");
  assert.equal(localDate(new Date("2026-09-28T23:30:00Z"), "UTC"), "2026-09-28");
});

const hours = (a: Date | undefined, b: Date | undefined) => (b!.getTime() - a!.getTime()) / 3_600_000;

test("startOfLocalDay is local midnight in the zone", () => {
  assert.equal(startOfLocalDay("2026-09-28", "Europe/Amsterdam")?.toISOString(), "2026-09-27T22:00:00.000Z");
  assert.equal(startOfLocalDay("2026-01-15", "Europe/Amsterdam")?.toISOString(), "2026-01-14T23:00:00.000Z");
  assert.equal(startOfLocalDay("2026-09-28", "UTC")?.toISOString(), "2026-09-28T00:00:00.000Z");
  assert.equal(startOfLocalDay("2026-09-28", "America/New_York")?.toISOString(), "2026-09-28T04:00:00.000Z");
  assert.equal(startOfLocalDay("2026-09-28", "Asia/Kolkata")?.toISOString(), "2026-09-27T18:30:00.000Z");
});

test("startOfLocalDay across DST: the spring day has 23 hours, the autumn day 25", () => {
  const z = "Europe/Amsterdam";
  assert.equal(hours(startOfLocalDay("2026-03-29", z), startOfLocalDay("2026-03-30", z)), 23);
  assert.equal(hours(startOfLocalDay("2026-10-25", z), startOfLocalDay("2026-10-26", z)), 25);
  assert.equal(hours(startOfLocalDay("2026-09-28", z), startOfLocalDay("2026-09-29", z)), 24);
});

test("startOfLocalDay where DST skips midnight starts at the first moment of the day", () => {
  // Chile moves from -04:00 to -03:00 at midnight on the first Sunday of September.
  const start = startOfLocalDay("2026-09-06", "America/Santiago")!;
  assert.equal(localDate(start, "America/Santiago"), "2026-09-06");
  assert.equal(localDate(new Date(start.getTime() - 1), "America/Santiago"), "2026-09-05");
});

test("startOfLocalDay refuses what is not a calendar date", () => {
  for (const bad of ["2026-02-30", "2026-13-01", "last week", "2026-9-28", "2026-09-28T00:00"]) {
    assert.equal(startOfLocalDay(bad, "Europe/Amsterdam"), undefined, bad);
  }
});
