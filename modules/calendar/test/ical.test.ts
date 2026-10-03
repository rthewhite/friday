import { test } from "node:test";
import assert from "node:assert/strict";
import { applyEdit, buildEvent, deleteOccurrence, EditRefused, expand, isInvitation, parseIcs, type Occurrence } from "../src/ical.js";
import { localIso, whenText } from "../src/format.js";
import { vtimezoneLines } from "../src/vtimezone.js";
import { allDay, timed, vcalendar } from "./fake-icloud.js";

const ZONE = "Europe/Amsterdam";
const NOW = new Date("2026-10-03T08:00:00Z");
const ms = (iso: string) => new Date(iso).getTime();
const range = (from: string, to: string) => [ms(from), ms(to)] as const;

function occurrences(ics: string, from: string, to: string): Occurrence[] {
  const [a, b] = range(from, to);
  return expand(parseIcs(ics), a, b, ZONE).sort((x, y) => x.startMs - y.startMs);
}

const iso = (o: Occurrence) => [localIso(o.startMs, ZONE), localIso(o.endMs, ZONE)];

test("a single timed event expands to itself with instants from its TZID", () => {
  const ics = vcalendar(timed("d1", "Dentist", "20261008T140000", "20261008T150000", ["LOCATION:Kerkstraat 12", "DESCRIPTION:Bring the card"]));
  const [o] = occurrences(ics, "2026-10-08T00:00:00+02:00", "2026-10-09T00:00:00+02:00");
  assert.deepEqual(iso(o), ["2026-10-08T14:00:00+02:00", "2026-10-08T15:00:00+02:00"]);
  assert.equal(o.title, "Dentist");
  assert.equal(o.location, "Kerkstraat 12");
  assert.equal(o.notes, "Bring the card");
  assert.equal(o.recurring, false);
  assert.equal(o.allDay, false);
  assert.equal(whenText(o, ZONE, NOW), "Thu 8 Oct, 14:00-15:00");
});

test("events outside the range are left out", () => {
  const ics = vcalendar(timed("d1", "Dentist", "20261008T140000", "20261008T150000"));
  assert.equal(occurrences(ics, "2026-10-09T00:00:00+02:00", "2026-10-10T00:00:00+02:00").length, 0);
});

test("a two-day all-day event has dates with an exclusive end internally and reads as two days", () => {
  const ics = vcalendar(allDay("a1", "Conference", "20261008", "20261010"));
  const [o] = occurrences(ics, "2026-10-09T00:00:00+02:00", "2026-10-10T00:00:00+02:00");
  assert.equal(o.allDay, true);
  assert.equal(o.startDate, "2026-10-08");
  assert.equal(o.endDate, "2026-10-10");
  assert.equal(whenText(o, ZONE, NOW), "Thu 8 Oct - Fri 9 Oct, all day");
});

test("UTC and floating times resolve, floating ones in the household zone", () => {
  const [u] = occurrences(vcalendar(["UID:u1", "SUMMARY:Call", "DTSTART:20261008T120000Z", "DTEND:20261008T123000Z"]), "2026-10-08T00:00:00+02:00", "2026-10-09T00:00:00+02:00");
  const [f] = occurrences(vcalendar(["UID:f1", "SUMMARY:Floating", "DTSTART:20261008T090000", "DURATION:PT45M"]), "2026-10-08T00:00:00+02:00", "2026-10-09T00:00:00+02:00");
  assert.deepEqual(iso(f), ["2026-10-08T09:00:00+02:00", "2026-10-08T09:45:00+02:00"]);
  assert.deepEqual(iso(u), ["2026-10-08T14:00:00+02:00", "2026-10-08T14:30:00+02:00"]);
});

const WEEKLY = vcalendar(
  timed("w1", "Standup", "20261006T090000", "20261006T091500", ["RRULE:FREQ=WEEKLY", "EXDATE;TZID=Europe/Amsterdam:20261020T090000"]),
  timed("w1", "Standup (moved)", "20261014T100000", "20261014T101500", ["RECURRENCE-ID;TZID=Europe/Amsterdam:20261013T090000"]),
);

test("a weekly event honours a moved and a deleted occurrence", () => {
  const all = occurrences(WEEKLY, "2026-10-05T00:00:00+02:00", "2026-11-01T00:00:00+01:00");
  assert.deepEqual(
    all.map((o) => [o.title, localIso(o.startMs, ZONE)]),
    [
      ["Standup", "2026-10-06T09:00:00+02:00"],
      ["Standup (moved)", "2026-10-14T10:00:00+02:00"],
      ["Standup", "2026-10-27T09:00:00+01:00"],
    ],
  );
  assert.ok(all.every((o) => o.recurring));
  assert.equal(all[1].recurrenceKey, "2026-10-13T09:00:00");
  // The moved occurrence is not on Tuesday the 13th any more.
  assert.equal(occurrences(WEEKLY, "2026-10-13T00:00:00+02:00", "2026-10-14T00:00:00+02:00").length, 0);
});

test("a weekly event stays at 09:00 local time across the late-October DST change", () => {
  const all = occurrences(WEEKLY, "2026-10-26T00:00:00+01:00", "2026-11-11T00:00:00+01:00");
  assert.deepEqual(all.map((o) => localIso(o.startMs, ZONE)), ["2026-10-27T09:00:00+01:00", "2026-11-03T09:00:00+01:00", "2026-11-10T09:00:00+01:00"]);
});

test("an occurrence moved into the range from past its end is included", () => {
  const ics = vcalendar(
    timed("w2", "Yoga", "20261005T190000", "20261005T200000", ["RRULE:FREQ=WEEKLY;COUNT=3"]),
    timed("w2", "Yoga early", "20261008T190000", "20261008T200000", ["RECURRENCE-ID;TZID=Europe/Amsterdam:20261012T190000"]),
  );
  const got = occurrences(ics, "2026-10-08T00:00:00+02:00", "2026-10-09T00:00:00+02:00");
  assert.deepEqual(got.map((o) => o.title), ["Yoga early"]);
});

test("cancelled occurrences are left out", () => {
  const ics = vcalendar(
    timed("w3", "Swim", "20261005T070000", "20261005T080000", ["RRULE:FREQ=DAILY;COUNT=3"]),
    timed("w3", "Swim", "20261006T070000", "20261006T080000", ["RECURRENCE-ID;TZID=Europe/Amsterdam:20261006T070000", "STATUS:CANCELLED"]),
  );
  assert.equal(occurrences(ics, "2026-10-05T00:00:00+02:00", "2026-10-08T00:00:00+02:00").length, 2);
});

test("when texts: across midnight, ending at midnight, and another year", () => {
  const span = (a: string, b: string) => ({ allDay: false, startMs: ms(a), endMs: ms(b) });
  assert.equal(whenText(span("2026-10-08T22:00:00+02:00", "2026-10-09T01:00:00+02:00"), ZONE, NOW), "Thu 8 Oct 22:00 - Fri 9 Oct 01:00");
  assert.equal(whenText(span("2026-10-08T22:00:00+02:00", "2026-10-09T00:00:00+02:00"), ZONE, NOW), "Thu 8 Oct, 22:00-24:00");
  assert.equal(whenText(span("2027-01-05T09:00:00+01:00", "2027-01-05T10:00:00+01:00"), ZONE, NOW), "Tue 5 Jan 2027, 09:00-10:00");
  assert.equal(whenText({ allDay: true, startMs: 0, endMs: 0, startDate: "2026-10-08", endDate: "2026-10-09" }, ZONE, NOW), "Thu 8 Oct, all day");
});

test("an event organized by someone else is an invitation; one by the user or without organizer is not", () => {
  const own = ["me@example.com", "me@icloud.com"];
  const [a, b] = range("2026-10-08T00:00:00+02:00", "2026-10-09T00:00:00+02:00");
  const board = expand(parseIcs(vcalendar(timed("i1", "Board", "20261008T100000", "20261008T110000", ["ORGANIZER;CN=Boss:mailto:Boss@Corp.example"]))), a, b, ZONE)[0];
  const lunch = expand(parseIcs(vcalendar(timed("i2", "Lunch", "20261008T120000", "20261008T130000", ["ORGANIZER:MAILTO:Me@Example.com"]))), a, b, ZONE)[0];
  const mine = expand(parseIcs(vcalendar(timed("i3", "Mine", "20261008T120000", "20261008T130000"))), a, b, ZONE)[0];
  assert.equal(isInvitation(board, own), true);
  assert.equal(isInvitation(lunch, own), false);
  assert.equal(isInvitation(mine, own), false);
});

// ---- Builders ------------------------------------------------------------------------------------------------

test("buildEvent writes a timed event in the household zone with a VTIMEZONE that resolves back", () => {
  const ics = buildEvent({ uid: "new-1", title: "Plumber", span: { allDay: false, startMs: ms("2026-10-13T09:00:00+02:00"), endMs: ms("2026-10-13T10:00:00+02:00") }, location: "Home", zone: ZONE, now: NOW });
  assert.match(ics, /DTSTART;TZID=Europe\/Amsterdam:20261013T090000/);
  assert.match(ics, /BEGIN:VTIMEZONE/);
  assert.match(ics, /RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU/);
  assert.ok(ics.indexOf("BEGIN:VTIMEZONE") < ics.indexOf("BEGIN:VEVENT"));
  const [o] = occurrences(ics, "2026-10-13T00:00:00+02:00", "2026-10-14T00:00:00+02:00");
  assert.deepEqual(iso(o), ["2026-10-13T09:00:00+02:00", "2026-10-13T10:00:00+02:00"]);
  assert.equal(o.location, "Home");
});

test("buildEvent writes all-day events as dates with an exclusive end", () => {
  const ics = buildEvent({ uid: "new-2", title: "Holiday", span: { allDay: true, startMs: 0, endMs: 0, startDate: "2026-10-08", endDate: "2026-10-10" }, zone: ZONE, now: NOW });
  assert.match(ics, /DTSTART;VALUE=DATE:20261008/);
  assert.match(ics, /DTEND;VALUE=DATE:20261010/);
  assert.doesNotMatch(ics, /VTIMEZONE/);
});

test("buildEvent repeats weekly until the given day, inclusive", () => {
  const ics = buildEvent({
    uid: "new-3", title: "Piano", span: { allDay: false, startMs: ms("2026-12-15T16:00:00+01:00"), endMs: ms("2026-12-15T17:00:00+01:00") },
    repeat: "weekly", repeatUntil: "2026-12-29", zone: ZONE, now: NOW,
  });
  assert.match(ics, /RRULE:FREQ=WEEKLY;UNTIL=20261229T225959Z/);
  const all = occurrences(ics, "2026-12-01T00:00:00+01:00", "2027-02-01T00:00:00+01:00");
  assert.deepEqual(all.map((o) => localIso(o.startMs, ZONE).slice(0, 10)), ["2026-12-15", "2026-12-22", "2026-12-29"]);
});

test("vtimezoneLines covers zones without DST with one observance", () => {
  const lines = vtimezoneLines("Asia/Tokyo", 2026);
  assert.deepEqual(lines.filter((l) => l.startsWith("BEGIN:")), ["BEGIN:VTIMEZONE", "BEGIN:STANDARD"]);
  assert.ok(lines.includes("TZOFFSETTO:+0900"));
});

test("an edit keeps properties Friday doesn't know about", () => {
  const ics = vcalendar(timed("d1", "Dentist", "20261008T140000", "20261008T150000", ["X-APPLE-TRAVEL-ADVISORY-BEHAVIOR:AUTOMATIC", "BEGIN:VALARM", "ACTION:DISPLAY", "TRIGGER:-PT15M", "DESCRIPTION:Reminder", "END:VALARM"]));
  const parsed = parseIcs(ics);
  const [occ] = expand(parsed, ms("2026-10-08T00:00:00+02:00"), ms("2026-10-09T00:00:00+02:00"), ZONE);
  const out = applyEdit(parsed, { occurrence: occ }, { span: { allDay: false, startMs: ms("2026-10-08T15:00:00+02:00"), endMs: ms("2026-10-08T16:00:00+02:00") }, location: "" }, ZONE, NOW);
  assert.match(out, /X-APPLE-TRAVEL-ADVISORY-BEHAVIOR:AUTOMATIC/);
  assert.match(out, /BEGIN:VALARM/);
  assert.match(out, /SEQUENCE:1/);
  const [o] = occurrences(out, "2026-10-08T00:00:00+02:00", "2026-10-09T00:00:00+02:00");
  assert.deepEqual(iso(o), ["2026-10-08T15:00:00+02:00", "2026-10-08T16:00:00+02:00"]);
  assert.equal(o.location, undefined);
});

function weeklyOccurrence(day: string) {
  const parsed = parseIcs(WEEKLY);
  const [occ] = expand(parsed, ms(`${day}T00:00:00+02:00`), ms(`${day}T23:59:00+02:00`), ZONE);
  return { parsed, occ };
}

test("an occurrence edit adds an override and changes only that occurrence", () => {
  const { parsed, occ } = weeklyOccurrence("2026-10-06");
  const out = applyEdit(parsed, { occurrence: occ, scope: "occurrence" }, { title: "Standup (remote)" }, ZONE, NOW);
  const all = occurrences(out, "2026-10-05T00:00:00+02:00", "2026-10-28T00:00:00+01:00");
  assert.deepEqual(all.map((o) => o.title), ["Standup (remote)", "Standup (moved)", "Standup"]);
  assert.match(out, /RECURRENCE-ID;TZID=Europe\/Amsterdam:20261006T090000/);
});

test("an occurrence edit of an already moved occurrence updates its override", () => {
  const parsed = parseIcs(WEEKLY);
  const [occ] = expand(parsed, ms("2026-10-14T00:00:00+02:00"), ms("2026-10-15T00:00:00+02:00"), ZONE);
  const out = applyEdit(parsed, { occurrence: occ, scope: "occurrence" }, { span: { allDay: false, startMs: ms("2026-10-14T11:00:00+02:00"), endMs: ms("2026-10-14T11:15:00+02:00") } }, ZONE, NOW);
  assert.equal((out.match(/RECURRENCE-ID/g) ?? []).length, 1);
  const [o] = occurrences(out, "2026-10-14T00:00:00+02:00", "2026-10-15T00:00:00+02:00");
  assert.equal(localIso(o.startMs, ZONE), "2026-10-14T11:00:00+02:00");
});

test("a series shift moves every occurrence, keeps the moved one and the deleted one", () => {
  const { parsed, occ } = weeklyOccurrence("2026-10-27");
  const span = { allDay: false, startMs: ms("2026-10-27T10:00:00+01:00"), endMs: ms("2026-10-27T10:15:00+01:00") };
  const out = applyEdit(parsed, { occurrence: occ, scope: "series" }, { span }, ZONE, NOW);
  const all = occurrences(out, "2026-10-05T00:00:00+02:00", "2026-11-04T00:00:00+01:00");
  assert.deepEqual(
    all.map((o) => [o.title, localIso(o.startMs, ZONE)]),
    [
      ["Standup", "2026-10-06T10:00:00+02:00"],
      ["Standup (moved)", "2026-10-14T10:00:00+02:00"],
      ["Standup", "2026-10-27T10:00:00+01:00"],
      ["Standup", "2026-11-03T10:00:00+01:00"],
    ],
  );
});

test("a series edit can change the duration and the title, also on overrides that had the old title", () => {
  const parsed = parseIcs(vcalendar(
    timed("w4", "Run", "20261005T070000", "20261005T080000", ["RRULE:FREQ=DAILY;COUNT=3"]),
    timed("w4", "Run", "20261006T073000", "20261006T083000", ["RECURRENCE-ID;TZID=Europe/Amsterdam:20261006T070000"]),
  ));
  const [occ] = expand(parsed, ms("2026-10-05T00:00:00+02:00"), ms("2026-10-06T00:00:00+02:00"), ZONE);
  const out = applyEdit(parsed, { occurrence: occ, scope: "series" }, { title: "Jog", span: { allDay: false, startMs: occ.startMs, endMs: occ.startMs + 30 * 60_000 } }, ZONE, NOW);
  const all = occurrences(out, "2026-10-05T00:00:00+02:00", "2026-10-08T00:00:00+02:00");
  assert.deepEqual(all.map((o) => [o.title, (o.endMs - o.startMs) / 60_000]), [["Jog", 30], ["Jog", 60], ["Jog", 30]]);
});

test("a series edit refuses a change of date", () => {
  const { parsed, occ } = weeklyOccurrence("2026-10-06");
  const span = { allDay: false, startMs: ms("2026-10-07T09:00:00+02:00"), endMs: ms("2026-10-07T09:15:00+02:00") };
  assert.throws(() => applyEdit(parsed, { occurrence: occ, scope: "series" }, { span }, ZONE, NOW), EditRefused);
});

test("deleting an occurrence hides only that one and drops its override", () => {
  const parsed = parseIcs(WEEKLY);
  const [moved] = expand(parsed, ms("2026-10-14T00:00:00+02:00"), ms("2026-10-15T00:00:00+02:00"), ZONE);
  const out = deleteOccurrence(parsed, moved.recurrenceKey!, ZONE, NOW);
  assert.doesNotMatch(out, /RECURRENCE-ID/);
  const all = occurrences(out, "2026-10-05T00:00:00+02:00", "2026-11-04T00:00:00+01:00");
  assert.deepEqual(all.map((o) => localIso(o.startMs, ZONE).slice(0, 10)), ["2026-10-06", "2026-10-27", "2026-11-03"]);
});

test("deleting an occurrence of an all-day series writes a date EXDATE", () => {
  const parsed = parseIcs(vcalendar(allDay("b1", "Bins", "20261005", "20261006", ["RRULE:FREQ=WEEKLY;COUNT=3"])));
  const [occ] = expand(parsed, ms("2026-10-12T00:00:00+02:00"), ms("2026-10-13T00:00:00+02:00"), ZONE);
  const out = deleteOccurrence(parsed, occ.recurrenceKey!, ZONE, NOW);
  assert.match(out, /EXDATE;VALUE=DATE:20261012/);
  assert.equal(occurrences(out, "2026-10-01T00:00:00+02:00", "2026-11-01T00:00:00+01:00").length, 2);
});
