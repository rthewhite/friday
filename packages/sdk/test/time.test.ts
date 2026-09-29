import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_TIME_ZONE, householdTimeZone, localDate, resolveTimeZone } from "../src/index.js";

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

test("localDate is the calendar date in the zone, not in UTC", () => {
  assert.equal(localDate(new Date("2026-09-28T23:30:00Z"), "Europe/Amsterdam"), "2026-09-29");
  assert.equal(localDate(new Date("2026-09-28T23:30:00Z"), "UTC"), "2026-09-28");
});
