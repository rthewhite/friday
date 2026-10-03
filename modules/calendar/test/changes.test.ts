import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_CHANGES, TOOL_UNDO_WINDOW_MS } from "../src/changes.js";
import { NotUndoableError, StaleEventError } from "../src/errors.js";
import type { EventView } from "../src/service.js";
import { timed, vcalendar } from "./fake-icloud.js";
import { error, harness } from "./harness.js";

type Listed = { events: EventView[] };

async function setup() {
  const h = await harness();
  const dentistUrl = h.fake.seed("home", "dentist", vcalendar(timed("dentist", "Dentist", "20261008T140000", "20261008T150000")));
  const standupUrl = h.fake.seed("home", "standup", vcalendar(timed("standup", "Standup", "20261006T090000", "20261006T091500", ["RRULE:FREQ=WEEKLY"])));
  const id = async (title: string, day: string) => ((await h.service.list({ from: day, to: day })) as Listed).events.find((e) => e.title === title)!.id;
  const titles = async (from: string, to: string) => ((await h.service.list({ from, to })) as Listed).events.map((e) => `${e.title} ${e.when}`);
  return { ...h, dentistUrl, standupUrl, id, titles };
}

test("create, confirmed edit and confirmed delete are logged with before/after objects and their source", async () => {
  const s = await setup();
  await s.service.create({ title: "Plumber", start: "2026-10-13T09:00" }, { channel: "voice" });
  const edit = (await s.service.previewUpdate({ id: await s.id("Dentist", "2026-10-08"), start: "2026-10-08T15:00" }, { channel: "chat", conversationId: "c-1" })) as { token: string };
  await s.service.confirm(edit.token, { channel: "chat", conversationId: "c-1" });
  const del = (await s.service.previewDelete({ id: await s.id("Standup", "2026-10-13"), scope: "occurrence" }, { channel: "voice" })) as { token: string };
  await s.service.confirm(del.token, { channel: "voice" });

  const [d, u, c] = s.changes.list(10);
  assert.deepEqual([c.action, c.source, c.beforeIcs, c.title], ["create", "voice", null, "Plumber"]);
  assert.match(c.afterIcs!, /SUMMARY:Plumber/);
  assert.ok(c.afterEtag);
  assert.equal(c.afterSummary!.when, "Tue 13 Oct, 09:00-10:00");

  assert.deepEqual([u.action, u.source, u.conversationId], ["update", "chat", "c-1"]);
  assert.match(u.beforeIcs!, /20261008T140000/);
  assert.match(u.afterIcs!, /20261008T150000/);
  assert.deepEqual([u.beforeSummary!.when, u.afterSummary!.when], ["Thu 8 Oct, 14:00-15:00", "Thu 8 Oct, 15:00-16:00"]);

  assert.deepEqual([d.action, d.scope, d.source], ["delete", "occurrence", "voice"]);
  assert.match(d.afterIcs!, /EXDATE/);
});

test("the log keeps the newest 500 entries", async () => {
  const s = await setup();
  const base = { action: "create" as const, calendarId: "home", objectUrl: "u", uid: "x", title: "t", beforeSummary: null, afterSummary: null, beforeIcs: null, afterIcs: null, afterEtag: null, source: "chat" as const };
  for (let i = 0; i < MAX_CHANGES + 1; i++) s.changes.record({ ...base, title: `t${i}` });
  const all = s.changes.list(1000);
  assert.equal(all.length, MAX_CHANGES);
  assert.equal(all.at(-1)!.title, "t1");
  assert.equal(all[0].title, `t${MAX_CHANGES}`);
});

test("undoing a create deletes the event", async () => {
  const s = await setup();
  await s.service.create({ title: "Plumber", start: "2026-10-13T09:00" }, { channel: "voice" });
  const r = (await s.service.undoLast({ channel: "voice" })) as { undone: boolean; say: string };
  assert.equal(r.undone, true);
  assert.equal(r.say, 'Undid creating "Plumber" on Tue 13 Oct, 09:00-10:00; it is gone again.');
  assert.deepEqual(await s.titles("2026-10-13", "2026-10-13"), ["Standup Tue 13 Oct, 09:00-09:15"]);
});

test("undoing an edit restores the previous version", async () => {
  const s = await setup();
  const p = (await s.service.previewUpdate({ id: await s.id("Dentist", "2026-10-08"), start: "2026-10-08T15:00" })) as { token: string };
  await s.service.confirm(p.token, { channel: "chat" });
  const r = (await s.service.undoLast({ channel: "chat" })) as { say: string };
  assert.equal(r.say, 'Undid the change to "Dentist"; it is back to "Dentist" on Thu 8 Oct, 14:00-15:00.');
  assert.deepEqual(await s.titles("2026-10-08", "2026-10-08"), ["Dentist Thu 8 Oct, 14:00-15:00"]);
});

test("undoing a deletion recreates the event, the series, or the occurrence", async () => {
  const s = await setup();
  const p1 = (await s.service.previewDelete({ id: await s.id("Dentist", "2026-10-08") })) as { token: string };
  await s.service.confirm(p1.token, { channel: "voice" });
  const p2 = (await s.service.previewDelete({ id: await s.id("Standup", "2026-10-13"), scope: "series" })) as { token: string };
  await s.service.confirm(p2.token, { channel: "voice" });
  assert.deepEqual(await s.titles("2026-10-06", "2026-10-13"), []);

  const r1 = (await s.service.undoLast({ channel: "voice" })) as { say: string };
  assert.equal(r1.say, 'Undid deleting "Standup" (the whole series); it is back on Tue 13 Oct, 09:00-09:15.');
  assert.equal(s.fake.writes().at(-1)!.headers["if-none-match"], "*");
  const r2 = (await s.service.undoLast({ channel: "voice" })) as { say: string };
  assert.match(r2.say, /Undid deleting "Dentist"; it is back on Thu 8 Oct, 14:00-15:00/);
  assert.deepEqual(await s.titles("2026-10-06", "2026-10-13"), ["Standup Tue 6 Oct, 09:00-09:15", "Dentist Thu 8 Oct, 14:00-15:00", "Standup Tue 13 Oct, 09:00-09:15"]);

  const p3 = (await s.service.previewDelete({ id: await s.id("Standup", "2026-10-13"), scope: "occurrence" })) as { token: string };
  await s.service.confirm(p3.token, { channel: "voice" });
  await s.service.undoLast({ channel: "voice" });
  assert.deepEqual(await s.titles("2026-10-13", "2026-10-13"), ["Standup Tue 13 Oct, 09:00-09:15"]);
});

test("an undo is logged, marks the change, and is never itself a target", async () => {
  const s = await setup();
  await s.service.create({ title: "A", start: "2026-10-13T12:00" }, { channel: "voice" });
  await s.service.create({ title: "B", start: "2026-10-13T13:00" }, { channel: "voice" });
  await s.service.undoLast({ channel: "voice" });
  const [undo, b, a] = s.changes.list(10);
  assert.deepEqual([undo.action, undo.undoOf, b.undoneBy, undo.source], ["undo", b.id, undo.id, "voice"]);
  // The next undo goes to the change before, not to the undo.
  const r = (await s.service.undoLast({ channel: "voice" })) as { title: string };
  assert.equal(r.title, "A");
  assert.equal(s.changes.get(a.id)!.undoneBy !== undefined, true);
  const nothing = (await s.service.undoLast()) as { nothing?: boolean; say: string };
  assert.equal(nothing.nothing, true);
  assert.match(nothing.say, /nothing to undo/);
  await assert.rejects(s.service.undo(undo, "portal"), NotUndoableError);
  await assert.rejects(s.service.undo(s.changes.get(b.id)!, "portal"), /already undone/);
});

test("the tool only undoes tool changes from the last 24 hours", async () => {
  const s = await setup();
  await s.service.create({ title: "Old", start: "2026-10-13T12:00" }, { channel: "voice" });
  s.clock.t += TOOL_UNDO_WINDOW_MS + 1000;
  const r = (await s.service.undoLast()) as { nothing?: boolean };
  assert.equal(r.nothing, true);
  // The portal has no time limit.
  const [old] = s.changes.list(1);
  const { say } = await s.service.undo(old, "portal");
  assert.match(say, /Undid creating "Old"/);
  assert.equal(s.changes.list(1)[0].source, "portal");
});

test("an event changed in iCloud since Friday's change is not undone, and the current version is returned", async () => {
  const s = await setup();
  const p = (await s.service.previewUpdate({ id: await s.id("Dentist", "2026-10-08"), start: "2026-10-08T15:00" })) as { token: string };
  await s.service.confirm(p.token, { channel: "voice" });
  s.fake.touch(s.dentistUrl, vcalendar(timed("dentist", "Dentist", "20261008T170000", "20261008T180000")));
  const e = await error(s.service.undoLast({ channel: "voice" }));
  assert.ok(e instanceof StaleEventError);
  assert.match(e.message, /changed in iCloud since Friday's change/);
  assert.match(e.message, /It is now: "Dentist", Thu 8 Oct, 17:00-18:00/);
  assert.match(s.fake.objects.get(s.dentistUrl)!.ics, /20261008T170000/);
  assert.equal(s.changes.list(1)[0].action, "update");
});

test("calendar_undo leaves calendars switched off alone; the portal may still undo there", async () => {
  const s = await setup();
  await s.service.create({ title: "Plumber", start: "2026-10-13T09:00" }, { channel: "voice" });
  await s.settings.update({ calendars: { home: { use: false } } }, s.service.lastAccount!.calendars);
  await assert.rejects(s.service.undoLast({ channel: "voice" }), (e: unknown) => e instanceof NotUndoableError && /no longer available to Friday/.test((e as Error).message));
  const { say } = await s.service.undo(s.changes.list(1)[0], "portal");
  assert.match(say, /Undid creating "Plumber"/);
});

test("a conversation id is recorded when the call has one", async () => {
  const s = await setup();
  await s.service.create({ title: "A", start: "2026-10-13T12:00" }, { channel: "voice" });
  await s.service.create({ title: "B", start: "2026-10-13T13:00" }, { channel: "chat", conversationId: "conv-9" });
  const [b, a] = s.changes.list(2);
  assert.equal(a.conversationId, undefined);
  assert.equal(b.conversationId, "conv-9");
});
