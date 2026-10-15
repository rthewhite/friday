import { test } from "node:test";
import assert from "node:assert/strict";
import { spokenWhen } from "../src/alerts/when.js";

const zone = "Europe/Amsterdam";
const when = (due: string, now: string, language: "nl" | "en", z = zone) => spokenWhen(new Date(due), new Date(now), z, language);

test("an alarm set at 23:41 for 07:30 the next morning is 'morgen' with its weekday and date", () => {
  assert.equal(when("2026-10-14T05:30:00Z", "2026-10-13T21:41:00Z", "nl"), "morgen, woensdag 14 oktober, om 07:30");
  assert.equal(when("2026-10-14T05:30:00Z", "2026-10-13T21:41:00Z", "en"), "tomorrow, Wednesday 14 October, at 07:30");
});

test("a timer due the same day is 'today at'", () => {
  assert.equal(when("2026-10-08T10:05:00Z", "2026-10-08T10:00:00Z", "en"), "today at 12:05");
  assert.equal(when("2026-10-08T10:05:30Z", "2026-10-08T10:00:00Z", "nl"), "vandaag om 12:05");
});

test("later days have their weekday and date only", () => {
  assert.equal(when("2026-10-16T05:30:00Z", "2026-10-13T21:41:00Z", "en"), "Friday 16 October at 07:30");
  assert.equal(when("2026-10-16T05:30:00Z", "2026-10-13T21:41:00Z", "nl"), "vrijdag 16 oktober om 07:30");
});

test("the household zone decides the time and the day, not UTC", () => {
  // 05:30 UTC is 07:30 in Amsterdam summer time.
  assert.equal(when("2026-10-14T05:30:00Z", "2026-10-14T04:00:00Z", "en"), "today at 07:30");
  // 22:30 UTC on the 13th is already the 14th in Amsterdam, so 00:10 the same local day is today.
  assert.equal(when("2026-10-13T22:10:00Z", "2026-10-13T22:05:00Z", "en"), "today at 00:10");
  assert.equal(when("2026-10-14T05:30:00Z", "2026-10-14T04:00:00Z", "en", "UTC"), "today at 05:30");
});
