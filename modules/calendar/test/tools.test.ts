import { test } from "node:test";
import assert from "node:assert/strict";
import { InputError, ReadOnlyError } from "../src/errors.js";
import type { EventView } from "../src/service.js";
import { CAL, FakeICloud, allDay, timed, vcalendar } from "./fake-icloud.js";
import { error, harness } from "./harness.js";

type Listed = { events: EventView[]; truncated?: boolean; total?: number };

async function seeded() {
  const h = await harness();
  h.fake.seed("home", "swim", vcalendar(timed("swim", "Swimming lesson", "20261003T100000", "20261003T110000")));
  h.fake.seed("home", "dentist", vcalendar(timed("dentist", "Dentist", "20261008T140000", "20261008T150000", ["LOCATION:Kerkstraat 12"])));
  h.fake.seed("home", "bday", vcalendar(allDay("bday", "Ma's birthday", "20261003", "20261004")));
  h.fake.seed("work", "standup", vcalendar(
    timed("standup", "Standup", "20260929T090000", "20260929T091500", ["RRULE:FREQ=WEEKLY"]),
    timed("standup", "Standup", "20261007T090000", "20261007T091500", ["RECURRENCE-ID;TZID=Europe/Amsterdam:20261006T090000"]),
  ));
  h.fake.seed("holidays", "dentist-2027", vcalendar(timed("d27", "Dentist checkup", "20270301T090000", "20270301T100000")));
  return h;
}

// ---- calendar_list_events ------------------------------------------------------------------------------------

test("today's events include all-day and timed ones from used calendars", async () => {
  const { service } = await seeded();
  const { events } = (await service.list({ from: "2026-10-03", to: "2026-10-03" })) as Listed;
  assert.deepEqual(events.map((e) => [e.title, e.when, e.calendar]), [
    ["Ma's birthday", "Sat 3 Oct, all day", "Home"],
    ["Swimming lesson", "Sat 3 Oct, 10:00-11:00", "Home"],
  ]);
  const [bday, swim] = events;
  assert.deepEqual([bday.start, bday.end, bday.allDay], ["2026-10-03", "2026-10-03", true]);
  assert.deepEqual([swim.start, swim.end], ["2026-10-03T10:00:00+02:00", "2026-10-03T11:00:00+02:00"]);
  assert.match(swim.id, /^e[a-z2-9]{4}$/);
});

test("without a range it covers today and the next 7 days", async () => {
  const { service } = await seeded();
  const { events } = (await service.list({})) as Listed;
  assert.deepEqual(events.map((e) => e.title), ["Ma's birthday", "Swimming lesson", "Standup", "Dentist"]);
  assert.equal(events[2].when, "Wed 7 Oct, 09:00-09:15");
});

test("a moved occurrence is listed on its new day only", async () => {
  const { service } = await seeded();
  const tue = (await service.list({ from: "2026-10-06", to: "2026-10-06" })) as Listed;
  assert.equal(tue.events.length, 0);
  const wed = (await service.list({ from: "2026-10-07", to: "2026-10-07" })) as Listed;
  assert.deepEqual(wed.events.map((e) => [e.title, e.recurring]), [["Standup", true]]);
});

test("a query searches title, location and notes for every word over the next 365 days", async () => {
  const { service } = await seeded();
  const { events } = (await service.list({ query: "dentist" })) as Listed;
  assert.deepEqual(events.map((e) => e.title), ["Dentist", "Dentist checkup"]);
  const byPlace = (await service.list({ query: "KERKSTRAAT dentist" })) as Listed;
  assert.deepEqual(byPlace.events.map((e) => e.location), ["Kerkstraat 12"]);
});

test("read-only calendars are marked, with a reason", async () => {
  const { service } = await seeded();
  const { events } = (await service.list({ query: "checkup" })) as Listed;
  assert.equal(events[0].readOnly, true);
  assert.match(events[0].readOnlyReason!, /Holidays NL.*read-only/);
});

test("the calendar filter takes a name, and an unknown name lists the calendars", async () => {
  const { service } = await seeded();
  const { events } = (await service.list({ calendar: "work", from: "2026-10-03", to: "2026-10-10" })) as Listed;
  assert.deepEqual(events.map((e) => e.calendar), ["Work"]);
  const e = await error(service.list({ calendar: "Gym" }));
  assert.ok(e instanceof InputError);
  assert.match(e.message, /"Home", "Work", "Holidays NL"/);
});

test("unused calendars are invisible", async () => {
  const h = await seeded();
  const account = await h.service.account();
  await h.settings.update({ calendars: { work: { use: false } } }, account.calendars);
  const { events } = (await h.service.list({ from: "2026-10-07", to: "2026-10-07" })) as Listed;
  assert.equal(events.length, 0);
  await assert.rejects(h.service.list({ calendar: "Work" }), InputError);
});

test("range validation: too long, reversed, and unparseable values", async () => {
  const { service } = await seeded();
  assert.match((await error(service.list({ from: "2026-10-01", to: "2027-11-05" }))).message, /at most 366 days/);
  assert.match((await error(service.list({ from: "2026-10-05", to: "2026-10-04" }))).message, /to must be after from/);
  assert.match((await error(service.list({ from: "next tuesday" }))).message, /^from must be/);
  assert.match((await error(service.list({ to: "2026-02-30" }))).message, /^to must be/);
  // A full year from a date is fine.
  await service.list({ from: "2026-10-01", to: "2027-10-01" });
});

test("results are capped at 50 with the total", async () => {
  const h = await harness();
  h.fake.seed("home", "daily", vcalendar(timed("daily", "Pill", "20261001T080000", "20261001T080500", ["RRULE:FREQ=DAILY"])));
  const r = (await h.service.list({ from: "2026-10-01", to: "2026-12-31" })) as Listed;
  assert.equal(r.events.length, 50);
  assert.equal(r.truncated, true);
  assert.equal(r.total, 92);
});

// ---- calendar_create_event -----------------------------------------------------------------------------------

test("a simple create goes to the default calendar, lasts an hour and reads back", async () => {
  const h = await harness();
  const r = (await h.service.create({ title: "Plumber", start: "2026-10-13T09:00" })) as { created: EventView; overlaps: unknown[]; say: string };
  assert.equal(r.created.calendar, "Home");
  assert.equal(r.created.when, "Tue 13 Oct, 09:00-10:00");
  assert.equal(r.say, 'Created "Plumber" on Tue 13 Oct, 09:00-10:00 in Home.');
  assert.deepEqual(r.overlaps, []);
  const put = h.fake.writes()[0];
  assert.equal(put.headers["if-none-match"], "*");
  assert.ok(put.url.startsWith(CAL("home")));
  assert.match(put.body!, /DTSTART;TZID=Europe\/Amsterdam:20261013T090000/);
  assert.equal(h.writes(), 1);
  // The new event can be found and has a usable id.
  const listed = (await h.service.list({ from: "2026-10-13", to: "2026-10-13" })) as Listed;
  assert.equal(listed.events[0].id, r.created.id);
});

test("a clash is reported but the event is still created", async () => {
  const h = await harness();
  h.fake.seed("work", "dentist", vcalendar(timed("dentist", "Dentist", "20261013T090000", "20261013T093000")));
  const r = (await h.service.create({ title: "Plumber", start: "2026-10-13T09:00", end: "2026-10-13T11:00" })) as { overlaps: { title: string }[]; say: string };
  assert.deepEqual(r.overlaps.map((o) => o.title), ["Dentist"]);
  assert.match(r.say, /overlaps "Dentist"/);
  assert.equal(h.fake.writes().length, 1);
});

test("a weekly event repeats until the given day", async () => {
  const h = await harness();
  await h.service.create({ title: "Piano", start: "2026-10-06T16:00", repeat: "weekly", repeatUntil: "2026-10-20" });
  const r = (await h.service.list({ from: "2026-10-01", to: "2026-11-30" })) as Listed;
  assert.deepEqual(r.events.map((e) => e.start.slice(0, 10)), ["2026-10-06", "2026-10-13", "2026-10-20"]);
  assert.ok(r.events.every((e) => e.recurring));
});

test("an all-day event takes dates with an inclusive end", async () => {
  const h = await harness();
  const r = (await h.service.create({ title: "Holiday", start: "2026-10-12", end: "2026-10-16" })) as { created: EventView };
  assert.deepEqual([r.created.allDay, r.created.start, r.created.end, r.created.when], [true, "2026-10-12", "2026-10-16", "Mon 12 Oct - Fri 16 Oct, all day"]);
  assert.match(h.fake.writes()[0].body!, /DTEND;VALUE=DATE:20261017/);
});

test("a read-only or unknown calendar creates nothing", async () => {
  const h = await harness();
  const ro = await error(h.service.create({ title: "x", start: "2026-10-13T09:00", calendar: "Holidays NL" }));
  assert.ok(ro instanceof ReadOnlyError);
  assert.match(ro.message, /read-only/);
  await assert.rejects(h.service.create({ title: "x", start: "2026-10-13T09:00", calendar: "Gym" }), InputError);
  assert.equal(h.fake.writes().length, 0);
});

test("create validation: title, start, mixed kinds, end before start, repeat", async () => {
  const h = await harness();
  assert.match((await error(h.service.create({ start: "2026-10-13T09:00" }))).message, /title is required/);
  assert.match((await error(h.service.create({ title: "x" }))).message, /start is required/);
  assert.match((await error(h.service.create({ title: "x", start: "2026-10-13T09:00", allDay: true }))).message, /all-day event takes dates/);
  assert.match((await error(h.service.create({ title: "x", start: "2026-10-13", allDay: false }))).message, /timed event takes a date-time/);
  assert.match((await error(h.service.create({ title: "x", start: "2026-10-13T09:00", end: "2026-10-13T08:00" }))).message, /end can't be before start/);
  assert.match((await error(h.service.create({ title: "x", start: "2026-10-13T09:00", repeat: "hourly" }))).message, /repeat must be one of/);
  assert.match((await error(h.service.create({ title: "x", start: "2026-10-13T09:00", repeatUntil: "2026-12-01" }))).message, /needs repeat/);
  assert.equal(h.fake.writes().length, 0);
});

test("a calendar that refuses a write with 403 becomes read-only", async () => {
  const fake = new FakeICloud({ calendars: [{ id: "shared", name: "Family" }] });
  const h = await harness(fake);
  // The fake reports no privileges, so Friday assumes writable; make iCloud refuse.
  fake.calendars = [{ id: "shared", name: "Family", privileges: ["read"] }];
  await assert.rejects(h.service.create({ title: "x", start: "2026-10-13T09:00" }), ReadOnlyError);
  assert.equal(h.service.lastAccount!.calendars[0].writable, false);
});
