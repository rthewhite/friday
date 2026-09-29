import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatDuration, parseCoordinates, resolveTimeZone, validateTimeArgs } from "../src/helpers.js";

describe("parseCoordinates", () => {
  it("parses a plain pair", () => {
    assert.deepEqual(parseCoordinates("52.379,4.899"), { name: "52.379,4.899", lat: 52.379, lon: 4.899 });
  });

  it("tolerates surrounding and inner whitespace", () => {
    assert.deepEqual(parseCoordinates("  52.379 , 4.899 "), { name: "52.379,4.899", lat: 52.379, lon: 4.899 });
  });

  it("parses negative coordinates", () => {
    assert.deepEqual(parseCoordinates("-33.865,-151.209"), { name: "-33.865,-151.209", lat: -33.865, lon: -151.209 });
  });

  it("parses integer coordinates", () => {
    assert.deepEqual(parseCoordinates("52,4"), { name: "52,4", lat: 52, lon: 4 });
  });

  it("rejects an out-of-range latitude", () => {
    assert.equal(parseCoordinates("91,4.899"), null);
  });

  it("rejects an out-of-range longitude", () => {
    assert.equal(parseCoordinates("52.379,181"), null);
  });

  it("rejects a place name", () => {
    assert.equal(parseCoordinates("Amsterdam Centraal"), null);
  });

  it("rejects a place name that merely contains a comma", () => {
    assert.equal(parseCoordinates("Bergen, Norway"), null);
  });

  it("rejects a lone number", () => {
    assert.equal(parseCoordinates("52.379"), null);
  });
});

describe("formatDuration", () => {
  it("describes zero as less than a minute", () => {
    assert.equal(formatDuration(0), "less than a minute");
  });

  it("describes a sub-minute duration as less than a minute", () => {
    assert.equal(formatDuration(20), "less than a minute");
  });

  it("rounds up into the first minute", () => {
    assert.equal(formatDuration(45), "1 min");
  });

  it("formats minutes", () => {
    assert.equal(formatDuration(480), "8 min");
  });

  it("formats an exact hour without a minute part", () => {
    assert.equal(formatDuration(3600), "1 hour");
  });

  it("rounds 59:59 up to a whole hour rather than saying 60 min", () => {
    assert.equal(formatDuration(3599), "1 hour");
  });

  it("formats hours and minutes", () => {
    assert.equal(formatDuration(4340), "1 hour 12 min");
  });

  it("pluralises hours", () => {
    assert.equal(formatDuration(7800), "2 hours 10 min");
  });
});

describe("validateTimeArgs", () => {
  const now = Date.parse("2026-08-08T12:00:00Z");
  const zone = "Europe/Amsterdam";

  function failure(result: ReturnType<typeof validateTimeArgs>): string {
    assert.equal(result.ok, false);
    return result.ok ? "" : result.message;
  }

  it("accepts no times at all", () => {
    assert.deepEqual(validateTimeArgs({}, zone, now), { ok: true });
  });

  it("rejects both times together", () => {
    assert.match(failure(validateTimeArgs({ departAt: "2026-08-09T08:00:00Z", arriveAt: "2026-08-09T09:00:00Z" }, zone, now)), /not both/);
  });

  it("rejects an unparseable departAt and names it", () => {
    assert.match(failure(validateTimeArgs({ departAt: "tomorrow morning" }, zone, now)), /departAt is not a valid timestamp/);
  });

  it("rejects an unparseable arriveAt and names it", () => {
    assert.match(failure(validateTimeArgs({ arriveAt: "half past nine" }, zone, now)), /arriveAt is not a valid timestamp/);
  });

  it("rejects a date that does not exist", () => {
    assert.match(failure(validateTimeArgs({ arriveAt: "2026-02-30T09:00" }, zone, now)), /arriveAt is not a valid timestamp/);
  });

  it("rejects a non-ISO timestamp without an offset rather than guessing its zone", () => {
    assert.match(failure(validateTimeArgs({ departAt: "Aug 9 2026 08:00" }, zone, now)), /departAt is not a valid timestamp/);
  });

  it("rejects a departAt in the past", () => {
    assert.match(failure(validateTimeArgs({ departAt: "2026-08-08T11:00:00Z" }, zone, now)), /in the past/);
  });

  it("accepts a future departAt and preserves an explicit offset", () => {
    assert.deepEqual(validateTimeArgs({ departAt: "2026-08-09T08:00:00+02:00" }, zone, now), { ok: true, departAt: "2026-08-09T08:00:00+02:00" });
  });

  it("reads a departAt without an offset in the zone, in summer time", () => {
    assert.deepEqual(validateTimeArgs({ departAt: "2026-08-09T08:00:00" }, zone, now), { ok: true, departAt: "2026-08-09T08:00:00+02:00" });
  });

  it("reads a local time in winter time, and fills in missing seconds", () => {
    assert.deepEqual(validateTimeArgs({ departAt: "2026-12-01 08:30" }, zone, now), { ok: true, departAt: "2026-12-01T08:30:00+01:00" });
  });

  it("uses the offset on the far side of a DST change", () => {
    // Amsterdam leaves summer time at 03:00 on 25 October 2026.
    assert.deepEqual(validateTimeArgs({ arriveAt: "2026-10-25T12:00" }, zone, now), { ok: true, arriveAt: "2026-10-25T12:00:00+01:00" });
    assert.deepEqual(validateTimeArgs({ arriveAt: "2026-10-24T12:00" }, zone, now), { ok: true, arriveAt: "2026-10-24T12:00:00+02:00" });
  });

  it("writes UTC as Z and negative offsets with a minus", () => {
    assert.deepEqual(validateTimeArgs({ arriveAt: "2026-08-09T09:00" }, "UTC", now), { ok: true, arriveAt: "2026-08-09T09:00:00Z" });
    assert.deepEqual(validateTimeArgs({ arriveAt: "2026-08-09T09:00" }, "America/New_York", now), { ok: true, arriveAt: "2026-08-09T09:00:00-04:00" });
  });

  it("checks the past against the local time in the zone, not UTC", () => {
    // 13:00 in Amsterdam is 11:00Z, an hour before now; read as UTC it would be an hour ahead.
    assert.match(failure(validateTimeArgs({ departAt: "2026-08-08T13:00:00" }, zone, now)), /in the past/);
    assert.equal(validateTimeArgs({ departAt: "2026-08-08T15:00:00" }, zone, now).ok, true);
  });

  it("passes an explicit Z through unchanged", () => {
    assert.deepEqual(validateTimeArgs({ arriveAt: "2026-08-09T09:00:00Z" }, zone, now), { ok: true, arriveAt: "2026-08-09T09:00:00Z" });
  });

  it("accepts an arriveAt in the past — only departure is checked", () => {
    assert.equal(validateTimeArgs({ arriveAt: "2026-08-08T11:00:00Z" }, zone, now).ok, true);
  });
});

describe("resolveTimeZone", () => {
  it("keeps a valid zone", () => {
    assert.deepEqual(resolveTimeZone("America/New_York"), { zone: "America/New_York", valid: true });
  });

  it("defaults an unset zone to Europe/Amsterdam", () => {
    assert.deepEqual(resolveTimeZone(undefined), { zone: "Europe/Amsterdam", valid: true });
  });

  it("falls back to Europe/Amsterdam for an invalid zone and says so", () => {
    assert.deepEqual(resolveTimeZone("Mars/Olympus"), { zone: "Europe/Amsterdam", valid: false });
  });
});
