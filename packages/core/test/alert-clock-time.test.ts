import { test } from "node:test";
import assert from "node:assert/strict";
import { alarmTime, wallClockInstant } from "../src/alerts/clock-time.js";

const zone = "Europe/Amsterdam";

function at(time: unknown, date: unknown, now: string, z = zone): string {
  const r = alarmTime(time, date, new Date(now), z);
  if ("error" in r) throw new Error(r.error);
  return r.at.toISOString();
}

function error(time: unknown, date: unknown, now: string): string {
  const r = alarmTime(time, date, new Date(now), zone);
  assert.ok("error" in r, `expected an error, got ${"at" in r && r.at.toISOString()}`);
  return r.error;
}

test("13 October: at 23:41 in Amsterdam, 07:30 is the next morning in summer time, not 07:30 UTC", () => {
  assert.equal(at("07:30", undefined, "2026-10-13T21:41:52Z"), "2026-10-14T05:30:00.000Z");
  assert.equal(at("08:30", undefined, "2026-10-13T21:41:52Z"), "2026-10-14T06:30:00.000Z");
});

test("without a date: later today when still ahead, else tomorrow; the same minute counts as passed", () => {
  assert.equal(at("07:30", undefined, "2026-10-14T04:00:00Z"), "2026-10-14T05:30:00.000Z"); // 06:00 local
  assert.equal(at("07:30", undefined, "2026-10-14T06:00:00Z"), "2026-10-15T05:30:00.000Z"); // 08:00 local
  assert.equal(at("07:30", undefined, "2026-10-14T05:30:00Z"), "2026-10-15T05:30:00.000Z");
  assert.equal(at("00:00", undefined, "2026-10-14T21:59:00Z"), "2026-10-14T22:00:00.000Z"); // 23:59 → midnight
});

test("the household zone decides, whatever it is", () => {
  assert.equal(at("07:30", undefined, "2026-10-14T00:00:00Z", "America/New_York"), "2026-10-14T11:30:00.000Z");
  assert.equal(at("07:30", undefined, "2026-10-14T00:00:00Z", "UTC"), "2026-10-14T07:30:00.000Z");
});

test("a given date: that time on that day, up to 7 days ahead", () => {
  assert.equal(at("06:45", "2026-10-16", "2026-10-13T21:41:00Z"), "2026-10-16T04:45:00.000Z");
  assert.equal(at("23:00", "2026-10-13", "2026-10-13T20:00:00Z"), "2026-10-13T21:00:00.000Z"); // today, still ahead
  assert.equal(at("07:00", "2026-10-20", "2026-10-13T08:00:00Z"), "2026-10-20T05:00:00.000Z"); // day 7
  assert.match(error("07:00", "2026-10-21", "2026-10-13T08:00:00Z"), /at most 7 days/);
  assert.match(error("07:00", "2026-10-12", "2026-10-13T08:00:00Z"), /in the past/);
  assert.match(error("07:00", "2026-10-13", "2026-10-13T08:00:00Z"), /already passed/);
  assert.match(error("07:00", "2026-02-30", "2026-02-01T08:00:00Z"), /not a date/);
});

test("the local date decides what today is, not the UTC one", () => {
  // 00:30 on 14 October in Amsterdam is still 13 October in UTC.
  assert.equal(at("07:00", "2026-10-21", "2026-10-13T22:30:00Z"), "2026-10-21T05:00:00.000Z");
  assert.match(error("07:00", "2026-10-13", "2026-10-13T22:30:00Z"), /in the past/);
});

test("times and dates in another form are refused", () => {
  for (const t of ["7:30", "07:30:00", "24:00", "07:60", "half acht", 730, undefined]) assert.match(error(t, undefined, "2026-10-13T12:00:00Z"), /HH:MM/);
  for (const d of ["16-10-2026", "2026-10-16T07:30", 20261016, ""]) assert.match(error("07:30", d, "2026-10-13T12:00:00Z"), /YYYY-MM-DD/);
});

test("summer time: 02:30 on 29 March 2026 doesn't exist in Amsterdam and is refused", () => {
  assert.equal(wallClockInstant("2026-03-29", "02:30", zone), undefined);
  assert.match(error("02:30", "2026-03-29", "2026-03-28T12:00:00Z"), /does not occur on 2026-03-29/);
  assert.match(error("02:30", undefined, "2026-03-28T23:30:00Z"), /does not occur on 2026-03-29/); // 00:30 local
  // Once past on the clock, it means the next night, which has it.
  assert.equal(at("02:30", undefined, "2026-03-29T08:00:00Z"), "2026-03-30T00:30:00.000Z");
  assert.equal(at("03:00", "2026-03-29", "2026-03-28T12:00:00Z"), "2026-03-29T01:00:00.000Z");
});

test("winter time: 02:30 on 25 October 2026 happens twice in Amsterdam, and the alarm takes the first", () => {
  assert.equal(wallClockInstant("2026-10-25", "02:30", zone)?.toISOString(), "2026-10-25T00:30:00.000Z"); // CEST
  assert.equal(at("02:30", "2026-10-25", "2026-10-24T12:00:00Z"), "2026-10-25T00:30:00.000Z");
  assert.equal(at("07:30", "2026-10-25", "2026-10-24T12:00:00Z"), "2026-10-25T06:30:00.000Z"); // CET after the change
});

test("winter time: once the first 02:30 has passed, the second one that night is still the next 02:30", () => {
  // 02:45 CEST, the first time round: 02:30 CET comes 45 minutes later, not tomorrow.
  assert.equal(at("02:30", undefined, "2026-10-25T00:45:00Z"), "2026-10-25T01:30:00.000Z");
  assert.equal(at("02:30", "2026-10-25", "2026-10-25T00:45:00Z"), "2026-10-25T01:30:00.000Z");
  assert.match(error("02:30", "2026-10-25", "2026-10-25T01:45:00Z"), /already passed/);
});

test("errors end without a full stop, so the tools can append theirs", () => {
  for (const e of [error("02:30", "2026-03-29", "2026-03-28T12:00:00Z"), error("7:30", undefined, "2026-10-13T12:00:00Z"), error("07:00", "2026-10-21", "2026-10-13T08:00:00Z")]) {
    assert.doesNotMatch(e, /\.$/, e);
  }
});
