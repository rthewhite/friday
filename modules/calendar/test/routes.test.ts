import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestHost } from "@friday/sdk/test";
import { createCalendarModule } from "../src/index.js";
import { FakeICloud, PASSWORD, USERNAME, timed, vcalendar } from "./fake-icloud.js";
import { NOW } from "./harness.js";

async function setup(password = PASSWORD) {
  const fake = new FakeICloud();
  const dentistUrl = fake.seed("home", "dentist", vcalendar(timed("dentist", "Dentist", "20261003T140000", "20261003T150000")));
  fake.seed("work", "standup", vcalendar(timed("standup", "Standup", "20261003T090000", "20261003T091500")));
  const clock = { t: new Date(NOW).getTime() };
  const host = await createTestHost(createCalendarModule({ fetch: fake.fetch, now: () => new Date(clock.t) }), { env: { ICLOUD_USERNAME: USERNAME, ICLOUD_APP_PASSWORD: password } });
  const bodies: string[] = [];
  const req = async (method: "GET" | "PUT" | "POST", path: string, body?: unknown) => {
    const r = await host.request(method, path, body);
    bodies.push(JSON.stringify(r.body));
    return { status: r.status, body: r.body as any };
  };
  const call = async (name: string, args: Record<string, unknown> = {}) => (await host.call(name, args, { channel: "voice" })).result as any;
  return { fake, host, clock, req, call, dentistUrl, bodies };
}

test("GET status shows the account, the connection and the calendars with their settings", async () => {
  const s = await setup();
  const { status, body } = await s.req("GET", "status");
  assert.equal(status, 200);
  assert.equal(body.username, USERNAME);
  assert.equal(body.connected, true);
  assert.equal(body.error, null);
  assert.ok(body.checkedAt);
  assert.deepEqual(body.calendars, [
    { id: "home", name: "Home", color: "#1badf8", writable: true, use: true, inAgenda: true, default: true },
    { id: "work", name: "Work", color: "#ff2968", writable: true, use: true, inAgenda: true, default: false },
    { id: "holidays", name: "Holidays NL", color: null, writable: false, use: true, inAgenda: true, default: false },
  ]);
  await s.host.dispose();
});

test("GET status reports a rejected password without the password", async () => {
  const s = await setup("not-the-right-one");
  const { body } = await s.req("GET", "status");
  assert.equal(body.connected, false);
  assert.match(body.error, /app-specific password/);
  assert.ok(!JSON.stringify(body).includes("not-the-right-one"));
  await s.host.dispose();
});

test("PUT settings saves use, inAgenda and the default, and the agenda follows", async () => {
  const s = await setup();
  await s.host.runJob("refresh");
  assert.match((await s.req("GET", "agenda")).body.text, /Standup/);
  const { status, body } = await s.req("PUT", "settings", { calendars: { work: { inAgenda: false } }, defaultId: "work" });
  assert.equal(status, 200);
  assert.deepEqual(body.calendars.find((c: any) => c.id === "work"), { id: "work", name: "Work", color: "#ff2968", writable: true, use: true, inAgenda: false, default: true });
  const agenda = (await s.req("GET", "agenda")).body;
  assert.doesNotMatch(agenda.text, /Standup/);
  assert.match(agenda.text, /Dentist/);
  assert.ok(agenda.fetchedAt);
  await s.host.dispose();
});

test("PUT settings refuses an unknown id and a read-only default with 400, changing nothing", async () => {
  const s = await setup();
  const ro = await s.req("PUT", "settings", { defaultId: "holidays" });
  assert.equal(ro.status, 400);
  assert.match(ro.body.error, /read-only/);
  const unknown = await s.req("PUT", "settings", { calendars: { gym: { use: false } } });
  assert.equal(unknown.status, 400);
  const bad = await s.host.request("PUT", "settings", "not json{");
  assert.equal(bad.status, 400);
  const { body } = await s.req("GET", "status");
  assert.equal(body.calendars.find((c: any) => c.default).id, "home");
  await s.host.dispose();
});

test("GET changes lists Friday's changes newest first, with a limit", async () => {
  const s = await setup();
  await s.call("calendar_create_event", { title: "Plumber", start: "2026-10-13T09:00" });
  await s.call("calendar_create_event", { title: "Piano", start: "2026-10-14T16:00" });
  const { body } = await s.req("GET", "changes");
  assert.deepEqual(body.changes.map((c: any) => [c.action, c.title, c.source, c.undone, c.undoable]), [["create", "Piano", "voice", false, true], ["create", "Plumber", "voice", false, true]]);
  assert.equal(body.changes[1].after.when, "Tue 13 Oct, 09:00-10:00");
  assert.equal((await s.req("GET", "changes?limit=1")).body.changes.length, 1);
  assert.equal((await s.req("GET", "changes?limit=0")).status, 400);
  assert.equal((await s.req("GET", "changes?limit=abc")).status, 400);
  await s.host.dispose();
});

test("POST changes/:id/undo reverts an older change, logged with source portal", async () => {
  const s = await setup();
  const listed = await s.call("calendar_list_events", { from: "2026-10-03", to: "2026-10-03" });
  const dentist = listed.events.find((e: any) => e.title === "Dentist");
  const preview = await s.call("calendar_update_event", { id: dentist.id, start: "2026-10-03T16:00" });
  await s.call("calendar_confirm", { token: preview.token });
  s.clock.t += 2 * 24 * 60 * 60_000;
  const [edit] = (await s.req("GET", "changes")).body.changes;
  const { status, body } = await s.req("POST", `changes/${edit.id}/undo`);
  assert.equal(status, 200);
  assert.match(body.say, /back to "Dentist" on Sat 3 Oct, 14:00-15:00/);
  assert.equal(body.undo.source, "portal");
  assert.equal(body.change.undone, true);
  assert.match(s.fake.objects.get(s.dentistUrl)!.ics, /20261003T140000/);
  const again = await s.req("POST", `changes/${edit.id}/undo`);
  assert.equal(again.status, 409);
  assert.match(again.body.error, /already undone/);
  await s.host.dispose();
});

test("POST changes/:id/undo answers 409 with the current version when the event changed since, and 404 for no such change", async () => {
  const s = await setup();
  const listed = await s.call("calendar_list_events", { from: "2026-10-03", to: "2026-10-03" });
  const preview = await s.call("calendar_update_event", { id: listed.events.find((e: any) => e.title === "Dentist").id, start: "2026-10-03T16:00" });
  await s.call("calendar_confirm", { token: preview.token });
  s.fake.touch(s.dentistUrl, vcalendar(timed("dentist", "Dentist", "20261003T180000", "20261003T190000")));
  const [edit] = (await s.req("GET", "changes")).body.changes;
  const { status, body } = await s.req("POST", `changes/${edit.id}/undo`);
  assert.equal(status, 409);
  assert.deepEqual(body.current, { title: "Dentist", when: "Sat 3 Oct, 18:00-19:00" });
  assert.equal((await s.req("POST", "changes/999/undo")).status, 404);
  await s.host.dispose();
});

test("POST changes/:id/undo answers 409 when iCloud refuses the write as read-only", async () => {
  const s = await setup();
  await s.call("calendar_create_event", { title: "Plumber", start: "2026-10-13T09:00", calendar: "Work" });
  s.fake.calendars = s.fake.calendars.map((c) => (c.id === "work" ? { ...c, privileges: ["read"] } : c));
  const [create] = (await s.req("GET", "changes")).body.changes;
  const { status, body } = await s.req("POST", `changes/${create.id}/undo`);
  assert.equal(status, 409);
  assert.match(body.error, /read-only/);
  await s.host.dispose();
});

test("POST refresh rediscovers and refreshes the agenda, answering with the status", async () => {
  const s = await setup();
  s.fake.calendars = [...s.fake.calendars, { id: "family", name: "Family", privileges: ["read", "write"] }];
  const { status, body } = await s.req("POST", "refresh");
  assert.equal(status, 200);
  assert.ok(body.calendars.some((c: any) => c.name === "Family"));
  s.fake.failWith = 503;
  const failed = await s.req("POST", "refresh");
  assert.equal(failed.status, 200);
  assert.equal(failed.body.connected, false);
  assert.match(failed.body.error, /busy/);
  await s.host.dispose();
});

test("no route ever returns the password", async () => {
  const s = await setup();
  await s.req("GET", "status");
  await s.req("GET", "agenda");
  await s.req("GET", "changes");
  await s.req("POST", "refresh");
  await s.req("PUT", "settings", { defaultId: "holidays" });
  for (const b of s.bodies) assert.ok(!b.includes(PASSWORD), b);
  await s.host.dispose();
});
