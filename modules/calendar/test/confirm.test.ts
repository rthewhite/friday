import { test } from "node:test";
import assert from "node:assert/strict";
import { InputError, ReadOnlyError, StaleEventError, TokenError, UnknownEventError } from "../src/errors.js";
import type { EventView } from "../src/service.js";
import { TOKEN_TTL_MS } from "../src/tokens.js";
import { CAL, allDay, timed, vcalendar } from "./fake-icloud.js";
import { error, harness } from "./harness.js";

type Listed = { events: EventView[] };
type Preview = { token: string; expiresInSeconds: number; action: string; scope?: string; before: { when: string; title: string }; after?: { when: string; title: string; location?: string }; overlaps?: { title: string }[]; instruction: string };

async function setup() {
  const h = await harness();
  const dentistUrl = h.fake.seed("home", "dentist", vcalendar(timed("dentist", "Dentist", "20261008T140000", "20261008T150000", ["LOCATION:Kerkstraat 12"])));
  const standupUrl = h.fake.seed("work", "standup", vcalendar(timed("standup", "Standup", "20261006T090000", "20261006T091500", ["RRULE:FREQ=WEEKLY"])));
  h.fake.seed("work", "board", vcalendar(timed("board", "Board meeting", "20261009T100000", "20261009T110000", ["ORGANIZER;CN=Boss:mailto:boss@corp.example"])));
  h.fake.seed("holidays", "kings", vcalendar(allDay("kings", "Holiday", "20261009", "20261010")));
  const id = async (title: string, day: string) => {
    const { events } = (await h.service.list({ from: day, to: day })) as Listed;
    const e = events.find((x) => x.title === title);
    assert.ok(e, `${title} on ${day}`);
    return e.id;
  };
  return { ...h, dentistUrl, standupUrl, id };
}

test("an edit preview shows before and after with a token and changes nothing", async () => {
  const s = await setup();
  const p = (await s.service.previewUpdate({ id: await s.id("Dentist", "2026-10-08"), start: "2026-10-08T15:00" })) as Preview;
  assert.match(p.token, /^[a-z2-9]{6}$/);
  assert.equal(p.expiresInSeconds, 300);
  assert.equal(p.before.when, "Thu 8 Oct, 14:00-15:00");
  assert.equal(p.after!.when, "Thu 8 Oct, 15:00-16:00");
  assert.equal(p.after!.location, "Kerkstraat 12");
  assert.match(p.instruction, /calendar_confirm/);
  assert.equal(s.fake.writes().length, 0);
  assert.match(s.fake.objects.get(s.dentistUrl)!.ics, /20261008T140000/);
});

test("an edit preview reports overlaps at the new time and can clear the location", async () => {
  const s = await setup();
  const p = (await s.service.previewUpdate({ id: await s.id("Dentist", "2026-10-08"), start: "2026-10-09T10:30", location: "" })) as Preview;
  assert.deepEqual(p.overlaps!.map((o) => o.title), ["Board meeting"]);
  assert.equal(p.after!.location, undefined);
});

test("a recurring event needs a scope", async () => {
  const s = await setup();
  const e = await error(s.service.previewDelete({ id: await s.id("Standup", "2026-10-13") }));
  assert.ok(e instanceof InputError);
  assert.match(e.message, /only this occurrence.*whole series/);
  await assert.rejects(s.service.previewDelete({ id: await s.id("Standup", "2026-10-13"), scope: "all" }), /scope must be/);
});

test("a series can move to a later time on the same day, keeping its duration", async () => {
  const s = await setup();
  const p = (await s.service.previewUpdate({ id: await s.id("Standup", "2026-10-13"), scope: "series", start: "2026-10-13T10:00" })) as Preview & { appliesTo: string };
  assert.equal(p.after!.when, "Tue 13 Oct, 10:00-10:15");
  assert.equal(p.appliesTo, "every occurrence of the series");
  await s.service.confirm(p.token, { channel: "voice" });
  const { events } = (await s.service.list({ from: "2026-10-06", to: "2026-10-28" })) as Listed;
  assert.deepEqual(events.filter((e) => e.title === "Standup").map((e) => e.when), ["Tue 6 Oct, 10:00-10:15", "Tue 13 Oct, 10:00-10:15", "Tue 20 Oct, 10:00-10:15", "Tue 27 Oct, 10:00-10:15"]);
});

test("a series can't move to another day", async () => {
  const s = await setup();
  const e = await error(s.service.previewUpdate({ id: await s.id("Standup", "2026-10-13"), scope: "series", start: "2026-10-14T09:00" }));
  assert.match(e.message, /only move a whole series to another time of day/);
});

test("invitations and read-only calendars are refused before a token is issued", async () => {
  const s = await setup();
  const inv = await error(s.service.previewDelete({ id: await s.id("Board meeting", "2026-10-09") }));
  assert.ok(inv instanceof ReadOnlyError);
  assert.match(inv.message, /invitation from boss@corp\.example/);
  const ro = await error(s.service.previewUpdate({ id: await s.id("Holiday", "2026-10-09"), title: "x" }));
  assert.match(ro.message, /read-only calendar/);
});

test("an edit with nothing to change, or without an id, is refused", async () => {
  const s = await setup();
  await assert.rejects(s.service.previewUpdate({ id: await s.id("Dentist", "2026-10-08") }), /Nothing to change/);
  await assert.rejects(s.service.previewUpdate({ title: "x" }), /id is required/);
  await assert.rejects(s.service.previewUpdate({ id: "ezzzz", title: "x" }), UnknownEventError);
});

test("a confirmed edit is written with If-Match and returns the new event", async () => {
  const s = await setup();
  const etag = s.fake.objects.get(s.dentistUrl)!.etag;
  const p = (await s.service.previewUpdate({ id: await s.id("Dentist", "2026-10-08"), start: "2026-10-08T15:00", title: "Dentist (Dr. Bakker)" })) as Preview;
  const r = (await s.service.confirm(p.token)) as { done: boolean; event: EventView; say: string };
  assert.equal(r.done, true);
  assert.equal(r.event.when, "Thu 8 Oct, 15:00-16:00");
  assert.equal(r.say, 'Changed "Dentist": now "Dentist (Dr. Bakker)" on Thu 8 Oct, 15:00-16:00.');
  const [put] = s.fake.writes();
  assert.equal(put.headers["if-match"], etag);
  assert.match(s.fake.objects.get(s.dentistUrl)!.ics, /SUMMARY:Dentist \(Dr. Bakker\)/);
  // The returned id points at the new version, so a follow-up edit works.
  const p2 = (await s.service.previewUpdate({ id: r.event.id, notes: "Bring the card" })) as Preview;
  await s.service.confirm(p2.token);
});

test("a token works once, and not after it expired", async () => {
  const s = await setup();
  const p = (await s.service.previewDelete({ id: await s.id("Dentist", "2026-10-08") })) as Preview;
  await s.service.confirm(p.token);
  await assert.rejects(s.service.confirm(p.token), TokenError);
  assert.equal(s.fake.writes().length, 1);

  const s2 = await setup();
  const p2 = (await s2.service.previewDelete({ id: await s2.id("Dentist", "2026-10-08") })) as Preview;
  s2.clock.t += TOKEN_TTL_MS + 1;
  await assert.rejects(s2.service.confirm(p2.token), /expired/);
  assert.equal(s2.fake.writes().length, 0);
});

test("a change made on the phone after the preview stops the confirm and shows the current version", async () => {
  const s = await setup();
  const p = (await s.service.previewUpdate({ id: await s.id("Dentist", "2026-10-08"), start: "2026-10-08T15:00" })) as Preview;
  s.fake.touch(s.dentistUrl, vcalendar(timed("dentist", "Dentist", "20261008T160000", "20261008T170000")));
  const e = await error(s.service.confirm(p.token));
  assert.ok(e instanceof StaleEventError);
  assert.match(e.message, /changed in iCloud after the preview/);
  assert.match(e.message, /It is now: "Dentist", Thu 8 Oct, 16:00-17:00/);
  assert.deepEqual(e.current, { title: "Dentist", when: "Thu 8 Oct, 16:00-17:00" });
  assert.match(s.fake.objects.get(s.dentistUrl)!.ics, /20261008T160000/);
});

test("an event deleted on the phone before the preview is reported as gone", async () => {
  const s = await setup();
  const id = await s.id("Dentist", "2026-10-08");
  s.fake.objects.delete(s.dentistUrl);
  await assert.rejects(s.service.previewDelete({ id }), (e: unknown) => e instanceof StaleEventError && /no longer exists/.test((e as Error).message));
});

test("deleting one occurrence keeps the others", async () => {
  const s = await setup();
  const p = (await s.service.previewDelete({ id: await s.id("Standup", "2026-10-13"), scope: "occurrence" })) as Preview;
  const r = (await s.service.confirm(p.token)) as { say: string };
  assert.equal(r.say, 'Deleted "Standup" on Tue 13 Oct, 09:00-09:15 (only this occurrence).');
  assert.equal(s.fake.writes()[0].method, "PUT");
  const { events } = (await s.service.list({ from: "2026-10-06", to: "2026-10-21" })) as Listed;
  assert.deepEqual(events.filter((e) => e.title === "Standup").map((e) => e.start.slice(0, 10)), ["2026-10-06", "2026-10-20"]);
});

test("deleting a series or a single event removes the object", async () => {
  const s = await setup();
  const p = (await s.service.previewDelete({ id: await s.id("Standup", "2026-10-13"), scope: "series" })) as Preview;
  const r = (await s.service.confirm(p.token)) as { say: string };
  assert.match(r.say, /every other occurrence of the series/);
  assert.equal(s.fake.objects.has(s.standupUrl), false);
  const p2 = (await s.service.previewDelete({ id: await s.id("Dentist", "2026-10-08") })) as Preview;
  await s.service.confirm(p2.token);
  assert.equal(s.fake.objects.has(s.dentistUrl), false);
  assert.ok(s.fake.writes().every((w) => w.method === "DELETE" && w.headers["if-match"]));
  assert.ok(s.fake.writes()[0].url.startsWith(CAL("work")));
});

test("an occurrence edit changes only that occurrence", async () => {
  const s = await setup();
  const p = (await s.service.previewUpdate({ id: await s.id("Standup", "2026-10-13"), scope: "occurrence", start: "2026-10-13T11:00" })) as Preview;
  await s.service.confirm(p.token);
  const { events } = (await s.service.list({ from: "2026-10-06", to: "2026-10-21" })) as Listed;
  assert.deepEqual(events.filter((e) => e.title === "Standup").map((e) => e.when), ["Tue 6 Oct, 09:00-09:15", "Tue 13 Oct, 11:00-11:15", "Tue 20 Oct, 09:00-09:15"]);
});

test("a calendar switched off after listing is invisible to edits and confirmations", async () => {
  const s = await setup();
  const id = await s.id("Dentist", "2026-10-08");
  const p = (await s.service.previewDelete({ id })) as Preview;
  await s.settings.update({ calendars: { home: { use: false } } }, s.service.lastAccount!.calendars);
  await assert.rejects(s.service.previewUpdate({ id, title: "x" }), /no longer available to Friday/);
  await assert.rejects(s.service.confirm(p.token), /no longer available to Friday, so nothing changed/);
  assert.equal(s.fake.writes().length, 0);
});

test("writes trigger the agenda refresh", async () => {
  const s = await setup();
  const p = (await s.service.previewDelete({ id: await s.id("Dentist", "2026-10-08") })) as Preview;
  assert.equal(s.writes(), 0);
  await s.service.confirm(p.token);
  assert.equal(s.writes(), 1);
});
