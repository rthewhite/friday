import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestHost } from "@friday/sdk/test";
import { Agenda, AGENDA_MAX_CHARS, STALE_AFTER_MS } from "../src/agenda.js";
import { createCalendarModule } from "../src/index.js";
import { FakeICloud, PASSWORD, USERNAME, allDay, timed, vcalendar } from "./fake-icloud.js";
import { harness, NOW } from "./harness.js";

async function setup() {
  const h = await harness();
  h.fake.seed("home", "swim", vcalendar(timed("swim", "Swimming lesson", "20261003T100000", "20261003T110000", ["LOCATION:De Mirandabad"])));
  h.fake.seed("home", "bday", vcalendar(allDay("bday", "Ma's birthday", "20261003", "20261004")));
  h.fake.seed("work", "deadline", vcalendar(timed("deadline", "Report due", "20261003T170000", "20261003T173000")));
  h.fake.seed("home", "monday", vcalendar(timed("monday", "Dentist", "20261005T090000", "20261005T100000")));
  const agenda = new Agenda(h.service, h.settings, h.now);
  return { ...h, agenda };
}

test("the agenda lists today and tomorrow, all-day events first, and says when a day is empty", async () => {
  const s = await setup();
  await s.agenda.refresh();
  assert.equal(
    s.agenda.render(),
    [
      "## Calendar",
      "The user's iCloud calendar for today and tomorrow (times in Europe/Amsterdam). For other days, or to change an event, use the calendar tools.",
      "Today, Saturday 3 October:",
      "- all day: Ma's birthday",
      "- 10:00-11:00: Swimming lesson (De Mirandabad)",
      "- 17:00-17:30: Report due",
      "Tomorrow, Sunday 4 October:",
      "- nothing planned",
    ].join("\n"),
  );
});

test("today and tomorrow are worked out when the prompt is built, not when the events were fetched", async () => {
  const s = await setup();
  s.clock.t = new Date("2026-10-04T21:58:00Z").getTime(); // 23:58 on Sunday
  await s.agenda.refresh();
  s.clock.t = new Date("2026-10-04T22:01:00Z").getTime(); // 00:01 on Monday
  const text = s.agenda.render();
  assert.match(text, /Today, Monday 5 October:\n- 09:00-10:00: Dentist/);
  assert.match(text, /Tomorrow, Tuesday 6 October:\n- nothing planned/);
});

test("calendars with inAgenda off are left out", async () => {
  const s = await setup();
  await s.agenda.refresh();
  await s.settings.update({ calendars: { work: { inAgenda: false } } }, s.service.lastAccount!.calendars);
  assert.doesNotMatch(s.agenda.render(), /Report due/);
});

test("before any successful refresh the section says the calendar is unavailable", async () => {
  const s = await setup();
  s.fake.failWith = 0;
  await assert.rejects(s.agenda.refresh());
  assert.match(s.agenda.render(), /^## Calendar\nThe user's calendar is unavailable right now/);
});

test("a failed refresh keeps the cache, and an old cache says when it was fetched", async () => {
  const s = await setup();
  await s.agenda.refresh();
  s.fake.failWith = 503;
  s.clock.t += STALE_AFTER_MS + 5 * 60_000;
  await assert.rejects(s.agenda.refresh());
  const text = s.agenda.render();
  assert.match(text, /Swimming lesson/);
  assert.match(text, /\(Fetched at 10:00; iCloud hasn't answered since/);
  assert.equal(s.service.status.ok, false);
  assert.match(s.service.status.error!, /busy/);
});

test("a fresh cache doesn't mention when it was fetched", async () => {
  const s = await setup();
  await s.agenda.refresh();
  s.clock.t += STALE_AFTER_MS - 1000;
  assert.doesNotMatch(s.agenda.render(), /Fetched at/);
});

test("the section is cut to 2000 characters, saying how many events were left out", async () => {
  const s = await setup();
  for (let i = 0; i < 60; i++) {
    const hh = String(8 + Math.floor(i / 6)).padStart(2, "0"), mm = String((i % 6) * 10).padStart(2, "0");
    s.fake.seed("home", `m${i}`, vcalendar(timed(`m${i}`, `Meeting number ${i} about the quarterly planning`, `20261004T${hh}${mm}00`, `20261004T${hh}${mm}00`)));
  }
  await s.agenda.refresh();
  const text = s.agenda.render();
  assert.ok(text.length <= AGENDA_MAX_CHARS, String(text.length));
  assert.match(text, /\(\d+ more events left out; use calendar_list_events\.\)$/);
  assert.match(text, /Today, Saturday 3 October:/);
});

test("events across midnight read as until and from", async () => {
  const s = await setup();
  s.fake.seed("home", "party", vcalendar(timed("party", "Party", "20261003T220000", "20261004T020000")));
  await s.agenda.refresh();
  const text = s.agenda.render();
  assert.match(text, /- from 22:00: Party/);
  assert.match(text, /Tomorrow, Sunday 4 October:\n- until 02:00: Party/);
});

// ---- In the module -------------------------------------------------------------------------------------------

test("the module schedules the refresh job, runs it at init, and puts the agenda in voice and chat prompts", async () => {
  const fake = new FakeICloud();
  fake.seed("home", "swim", vcalendar(timed("swim", "Swimming lesson", "20261003T100000", "20261003T110000")));
  const host = await createTestHost(createCalendarModule({ fetch: fake.fetch, now: () => new Date(NOW) }), { env: { ICLOUD_USERNAME: USERNAME, ICLOUD_APP_PASSWORD: PASSWORD } });
  assert.deepEqual(host.jobs, [{ name: "refresh", everyMs: 300_000 }]);
  const run = await host.runJob("refresh");
  assert.deepEqual(run, { outcome: "ok", summary: "1 event in 3 calendars" });
  for (const channel of ["voice", "chat"] as const) assert.match(host.promptContext(channel), /10:00-11:00: Swimming lesson/);
  await host.dispose();
});

test("a module whose iCloud is down still loads, and its refresh job fails", async () => {
  const fake = new FakeICloud();
  fake.failWith = 0;
  const host = await createTestHost(createCalendarModule({ fetch: fake.fetch, now: () => new Date(NOW) }), { env: { ICLOUD_USERNAME: USERNAME, ICLOUD_APP_PASSWORD: PASSWORD } });
  const run = await host.runJob("refresh");
  assert.equal(run.outcome, "failed");
  assert.match(run.error!, /could not be reached/);
  assert.match(host.promptContext("voice"), /unavailable right now/);
  await host.dispose();
});
