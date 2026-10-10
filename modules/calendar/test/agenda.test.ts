import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestHost } from "@friday/sdk/test";
import { Agenda, AGENDA_MAX_CHARS, STALE_AFTER_MS } from "../src/agenda.js";
import { createCalendarModule } from "../src/index.js";
import { WORK_CALENDAR_ID } from "../src/work.js";
import { FakeICloud, PASSWORD, USERNAME, allDay, timed, vcalendar } from "./fake-icloud.js";
import { FakeIntake, INTAKE_KEY, INTAKE_URL, meeting } from "./fake-intake.js";
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
      "The user's calendars for today and tomorrow (times in Europe/Amsterdam). For other days, or to change an event, use the calendar tools.",
      "Today, Saturday 3 October:",
      "- all day: Ma's birthday [Home]",
      "- 10:00-11:00: Swimming lesson (De Mirandabad) [Home]",
      "- 17:00-17:30: Report due [Work]",
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
  assert.equal(
    s.agenda.render(),
    "## Calendar\nThe user's iCloud calendars are unavailable right now (iCloud could not be reached), so don't assume they are free. calendar_list_events tries again.",
  );
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

test("with a single calendar in the agenda, events carry no calendar name", async () => {
  const h = await harness(new FakeICloud({ calendars: [{ id: "home", name: "Home", privileges: ["read", "write"] }] }));
  h.fake.seed("home", "swim", vcalendar(timed("swim", "Swimming lesson", "20261003T100000", "20261003T110000")));
  const agenda = new Agenda(h.service, h.settings, h.now);
  await agenda.refresh();
  assert.match(agenda.render(), /- 10:00-11:00: Swimming lesson\n/);
});

// ---- With the Work calendar ----------------------------------------------------------------------------------

/** Home in iCloud with today's swim, and a work delivery with a tentative standup today and a cancelled call tomorrow. */
async function withWork(opts: { intake?: FakeIntake; noICloud?: boolean; receivedAt?: string } = {}) {
  const intake = opts.intake ?? new FakeIntake();
  intake.deliver(
    [
      meeting("MASH Standup", "2026-10-03T08:30:00+00:00", "2026-10-03T08:45:00+00:00", { location: "Microsoft Teams Meeting", showAs: "tentative" }),
      meeting("Geannuleerd: Vendor call", "2026-10-04T12:00:00+00:00", "2026-10-04T12:30:00+00:00", { showAs: "free" }),
      meeting("Next week", "2026-10-06T08:00:00+00:00", "2026-10-06T09:00:00+00:00"),
    ],
    opts.receivedAt ?? "2026-10-03T07:45:00Z",
  );
  const h = await harness(new FakeICloud({ calendars: [{ id: "home", name: "Home", privileges: ["read", "write"] }] }), { intake, noICloud: opts.noICloud });
  h.fake.seed("home", "swim", vcalendar(timed("swim", "Swimming lesson", "20261003T100000", "20261003T110000")));
  return { ...h, intake, agenda: new Agenda(h.service, h.settings, h.now) };
}

test("work and home events are listed together, with status and calendar", async () => {
  const s = await withWork();
  assert.deepEqual(await s.agenda.refresh(), { summary: "1 event in 1 calendar; work: 3 events (received 09:45)" });
  assert.equal(
    s.agenda.render(),
    [
      "## Calendar",
      "The user's calendars for today and tomorrow (times in Europe/Amsterdam). For other days, or to change an event, use the calendar tools.",
      "Today, Saturday 3 October:",
      "- 10:00-11:00: Swimming lesson [Home]",
      "- 10:30-10:45: MASH Standup (online) (tentative) [Work]",
      "Tomorrow, Sunday 4 October:",
      "- 14:00-14:30: Vendor call (cancelled) [Work]",
    ].join("\n"),
  );
});

test("a failed intake poll still refreshes iCloud, and the other way round", async () => {
  const s = await withWork();
  s.intake.respond = () => new Response("", { status: 500 });
  const r = await s.agenda.refresh();
  assert.match(r.summary, /^1 event in 1 calendar; work failed: The intake answered HTTP 500\.$/);
  assert.match(s.agenda.render(), /Swimming lesson/);
  assert.match(s.agenda.render(), /Work calendar \(Outlook\) is unavailable right now/);
  s.intake.respond = undefined;
  s.fake.failWith = 0;
  const again = await s.agenda.refresh();
  assert.match(again.summary, /^iCloud failed: .*; work: 3 events/);
  // The iCloud cache from before is kept, and the work events are there now.
  assert.match(s.agenda.render(), /Swimming lesson[\s\S]*MASH Standup/);
});

test("the refresh fails only when every configured source failed", async () => {
  const s = await withWork();
  s.intake.respond = () => new Response("", { status: 500 });
  s.fake.failWith = 0;
  await assert.rejects(s.agenda.refresh(), /iCloud failed: .*; work failed: The intake answered HTTP 500/);
});

test("with only the intake configured the refresh never asks iCloud", async () => {
  const s = await withWork({ noICloud: true });
  assert.deepEqual(await s.agenda.refresh(), { summary: "work: 3 events (received 09:45)" });
  assert.equal(s.fake.requests.length, 0);
  const text = s.agenda.render();
  assert.match(text, /- 10:30-10:45: MASH Standup \(online\) \(tentative\)\n/);
  assert.doesNotMatch(text, /iCloud/);
});

test("before iCloud ever answered, the section says so and still lists the work events", async () => {
  const s = await withWork();
  s.fake.failWith = 0;
  await s.agenda.refresh();
  const text = s.agenda.render();
  assert.match(text, /^## Calendar\nThe user's calendars for today and tomorrow.*\nThe user's iCloud calendars are unavailable right now/);
  assert.match(text, /- 10:30-10:45: MASH Standup \(online\) \(tentative\)/);
});

test("an old work copy is still listed, saying when it was last updated", async () => {
  const s = await withWork({ receivedAt: "2026-10-03T06:00:00Z" });
  await s.agenda.refresh(); // two hours after it was received
  assert.doesNotMatch(s.agenda.render(), /last updated/);
  s.clock.t = new Date("2026-10-03T11:00:00Z").getTime(); // five hours after
  const text = s.agenda.render();
  assert.match(text, /MASH Standup/);
  assert.match(text, /\(The Work calendar was last updated at 08:00, so it may be out of date\.\)$/);
});

test("without the intake configured the section doesn't mention a work calendar", async () => {
  const h = await harness(new FakeICloud({ calendars: [{ id: "home", name: "Home", privileges: ["read", "write"] }] }));
  const agenda = new Agenda(h.service, h.settings, h.now);
  await agenda.refresh();
  assert.doesNotMatch(agenda.render(), /Work|Outlook/);
});

test("the Work calendar can be kept out of the agenda", async () => {
  const s = await withWork();
  await s.agenda.refresh();
  await s.settings.update({ calendars: { [WORK_CALENDAR_ID]: { inAgenda: false } } }, s.service.knownCalendars());
  const text = s.agenda.render();
  assert.doesNotMatch(text, /MASH Standup/);
  // One calendar left in the agenda: no labels.
  assert.match(text, /- 10:00-11:00: Swimming lesson\n/);
});

test("the 2000-character cut still holds with calendar labels", async () => {
  const intake = new FakeIntake();
  const s = await withWork({ intake });
  intake.deliver(
    Array.from({ length: 60 }, (_, i) => meeting(`Work meeting number ${i} about the quarterly planning`, "2026-10-04T08:00:00+00:00", "2026-10-04T08:30:00+00:00", { location: "Microsoft Teams Meeting; _Room with a View" })),
    "2026-10-03T07:50:00Z",
  );
  await s.agenda.refresh();
  const text = s.agenda.render();
  assert.ok(text.length <= AGENDA_MAX_CHARS, String(text.length));
  assert.match(text, /\(\d+ more events left out; use calendar_list_events\.\)$/);
  assert.match(text, /- 10:00-11:00: Swimming lesson \[Home\]/);
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

test("an intake-only module's refresh job drains the intake and puts work events in the prompt", async () => {
  const intake = new FakeIntake();
  intake.deliver([meeting("MASH Standup", "2026-10-03T08:30:00+00:00", "2026-10-03T08:45:00+00:00")], "2026-10-03T07:45:00Z");
  const host = await createTestHost(createCalendarModule({ intakeFetch: intake.fetch, now: () => new Date(NOW) }), { env: { INTAKE_URL, INTAKE_KEY } });
  const run = await host.runJob("refresh");
  assert.equal(run.outcome, "ok");
  assert.equal(intake.queue.length, 0);
  assert.match(host.promptContext("voice"), /- 10:30-10:45: MASH Standup\n/);
  await host.dispose();
});
