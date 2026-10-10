import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryStorage } from "@friday/sdk";
import { InputError } from "../src/errors.js";
import { pickDelivery, SNAPSHOT_KEY, toOccurrence, WORK_CALENDAR_ID, workLocation, type IntakeItem } from "../src/work.js";
import { FakeICloud } from "./fake-icloud.js";
import { allDayItem, FakeIntake, meeting } from "./fake-intake.js";
import { harness, NOW } from "./harness.js";

const NOW_ISO = new Date(NOW).toISOString();

const names = (cals: { name: string }[]) => cals.map((c) => c.name);
const HOME_FAMILY = () => new FakeICloud({ calendars: [{ id: "home", name: "Home", privileges: ["read", "write"] }, { id: "family", name: "Family", privileges: ["read", "write"] }] });

// ---- The Work calendar entry --------------------------------------------------------------------------------

test("the Work calendar comes after iCloud's, read-only and from the intake", async () => {
  const h = await harness(HOME_FAMILY(), { intake: new FakeIntake() });
  const { calendars } = await h.service.account();
  assert.deepEqual(names(calendars), ["Home", "Family", "Work"]);
  assert.deepEqual(calendars[2], { id: WORK_CALENDAR_ID, url: "intake:work", name: "Work", writable: false, source: "intake" });
});

test("without iCloud keys only the Work calendar is listed, and iCloud is never asked", async () => {
  const h = await harness(new FakeICloud(), { intake: new FakeIntake(), noICloud: true });
  assert.deepEqual(names((await h.service.account()).calendars), ["Work"]);
  assert.equal(h.fake.requests.length, 0);
});

test("without the intake keys there is no Work calendar", async () => {
  const h = await harness(HOME_FAMILY());
  assert.deepEqual(names((await h.service.account()).calendars), ["Home", "Family"]);
});

test("an iCloud calendar called Work renames the intake one", async () => {
  const h = await harness(new FakeICloud(), { intake: new FakeIntake() });
  assert.deepEqual(names((await h.service.account()).calendars), ["Home", "Work", "Holidays NL", "Work (Outlook)"]);
});

test("when iCloud discovery fails the Work calendar is still listed, and the failure is kept", async () => {
  const h = await harness(new FakeICloud(), { intake: new FakeIntake() });
  h.fake.failWith = 500;
  assert.deepEqual(names((await h.service.account(true)).calendars), ["Work"]);
  assert.match(String(h.service.icloudError?.message), /500/);
  // Without the Work calendar to fall back on, the failure is thrown as before.
  const plain = await harness(new FakeICloud());
  plain.fake.failWith = 500;
  await assert.rejects(plain.service.account(true), /500/);
});

test("the Work calendar can't be the default for new events", async () => {
  const h = await harness(HOME_FAMILY(), { intake: new FakeIntake() });
  const { calendars } = await h.service.account();
  await assert.rejects(h.settings.update({ defaultId: WORK_CALENDAR_ID }, calendars), (e: unknown) => e instanceof InputError && /read-only/.test(e.message));
  assert.equal(h.settings.defaultCalendar(calendars)?.id, "home");
});

// ---- Snapshot: pick, validate, persist ----------------------------------------------------------------------

const workHarness = (intake = new FakeIntake(), storage?: MemoryStorage) => harness(HOME_FAMILY(), { intake, storage });
const titles = (items: { subject: string }[] | undefined) => (items ?? []).map((i) => i.subject);

test("a new delivery replaces the snapshot, stored before it is used", async () => {
  const intake = new FakeIntake().load("v3");
  const h = await workHarness(intake);
  assert.equal(await h.work.poll(), "5 events received");
  assert.equal(h.work.snapshot?.items.length, 5);
  assert.equal(h.work.snapshot?.receivedAt, "2026-10-03T07:45:36.788Z");
  assert.deepEqual(await h.storage.get(SNAPSHOT_KEY), h.work.snapshot);
  assert.deepEqual(h.work.status, { polledAt: NOW_ISO, ok: true });
});

test("a poll that finds nothing keeps the snapshot", async () => {
  const intake = new FakeIntake().load("v3");
  const h = await workHarness(intake);
  await h.work.poll();
  const before = h.work.snapshot;
  assert.equal(await h.work.poll(), "nothing waiting");
  assert.equal(h.work.snapshot, before);
  assert.equal(h.work.status.ok, true);
});

test("of several queued deliveries only the newest becomes the snapshot", async () => {
  const intake = new FakeIntake();
  for (const [i, at] of ["14:08:58", "14:27:11", "14:32:44", "14:33:02", "14:45:36"].entries()) {
    intake.deliver([meeting(`Version ${i + 1}`, "2026-10-05T07:30:00+00:00", "2026-10-05T07:45:00+00:00")], `2026-10-03T${at}.000Z`);
  }
  const h = await workHarness(intake);
  await h.work.poll();
  assert.deepEqual(titles(h.work.snapshot?.items), ["Version 5"]);
});

test("a tie on received_at goes to the later delivery, and other subjects are ignored", async () => {
  const intake = new FakeIntake();
  intake.deliver([meeting("First", "2026-10-05T07:30:00+00:00", "2026-10-05T08:00:00+00:00")], "2026-10-03T07:00:00Z");
  intake.deliver([meeting("Second", "2026-10-05T07:30:00+00:00", "2026-10-05T08:00:00+00:00")], "2026-10-03T07:00:00Z");
  // The fake only hands out what was asked for; give the picker an unrelated, newer delivery directly.
  const pick = pickDelivery([...intake.queue, { id: "x", subject: "mail", received_at: "2026-10-03T09:00:00Z", content: [] }]);
  assert.equal(pick.kind, "snapshot");
  assert.deepEqual(titles(pick.kind === "snapshot" ? pick.snapshot.items : []), ["Second"]);
  const h = await workHarness(intake);
  await h.work.poll();
  assert.deepEqual(titles(h.work.snapshot?.items), ["Second"]);
});

test("when the newest delivery is unusable an older, still newer one is used", async () => {
  const intake = new FakeIntake();
  intake.deliver([meeting("Older", "2026-10-05T07:30:00+00:00", "2026-10-05T08:00:00+00:00")], "2026-10-03T07:00:00Z");
  intake.deliver("not a list", "2026-10-03T07:30:00Z");
  const h = await workHarness(intake);
  await h.work.poll();
  assert.deepEqual(titles(h.work.snapshot?.items), ["Older"]);
});

test("deliveries older than the stored snapshot are not used", async () => {
  const intake = new FakeIntake();
  intake.deliver([meeting("Current", "2026-10-05T07:30:00+00:00", "2026-10-05T08:00:00+00:00")], "2026-10-03T07:00:00Z");
  const h = await workHarness(intake);
  await h.work.poll();
  intake.deliver([meeting("Stale", "2026-10-05T07:30:00+00:00", "2026-10-05T08:00:00+00:00")], "2026-10-03T06:00:00Z");
  assert.equal(await h.work.poll(), "no calendar delivery newer than the stored copy");
  assert.deepEqual(titles(h.work.snapshot?.items), ["Current"]);
});

test("events without an offset are invalid; a delivery of only those keeps the snapshot and fails the poll", async () => {
  const intake = new FakeIntake().load("v3");
  const h = await workHarness(intake);
  await h.work.poll();
  const before = h.work.snapshot;
  intake.load("old-format");
  intake.queue[0].received_at = "2026-10-03T08:00:00Z";
  await assert.rejects(h.work.poll(), /none of the 2 events .* is valid .*offset.*previous copy is kept/);
  assert.equal(h.work.snapshot, before);
  assert.equal(h.work.status.ok, false);
  assert.match(String(h.work.status.error), /offset/);
});

test("invalid events are left out and counted; an empty list is a valid, empty calendar", async () => {
  const intake = new FakeIntake();
  intake.deliver(
    [meeting("Good", "2026-10-05T07:30:00+00:00", "2026-10-05T08:00:00+00:00"), meeting("Backwards", "2026-10-05T09:00:00+00:00", "2026-10-05T08:00:00+00:00"), { subject: "No times" }],
    "2026-10-03T07:00:00Z",
  );
  const h = await workHarness(intake);
  await h.work.poll();
  assert.deepEqual(titles(h.work.snapshot?.items), ["Good"]);
  assert.equal(h.work.snapshot?.skipped, 2);
  assert.match(h.warnings.join("\n"), /left out 2 invalid events/);
  intake.deliver([], "2026-10-03T08:00:00Z");
  await h.work.poll();
  assert.deepEqual(h.work.snapshot?.items, []);
});

test("after a restart the stored snapshot is used without a delivery", async () => {
  const storage = new MemoryStorage();
  const first = await workHarness(new FakeIntake().load("v3"), storage);
  await first.work.poll();
  const again = await workHarness(new FakeIntake(), storage);
  assert.equal(again.work.snapshot?.items.length, 5);
  const r = (await again.service.list({ from: "2026-10-05", to: "2026-10-05", calendar: "Work" })) as { events: { title: string }[] };
  assert.deepEqual(r.events.map((e) => e.title), ["Team Standup", "Quarterly planning"]);
});

test("a delivery of exactly 256 events is flagged as possibly cut off", async () => {
  const intake = new FakeIntake();
  intake.deliver(Array.from({ length: 256 }, (_, i) => meeting(`Meeting ${i}`, "2026-10-05T07:30:00+00:00", "2026-10-05T08:00:00+00:00")), "2026-10-03T07:00:00Z");
  const h = await workHarness(intake);
  await h.work.poll();
  assert.match(String(h.work.status.warning), /exactly 256 events/);
  assert.match(h.warnings.join("\n"), /exactly 256 events/);
});

// ---- Mapping ------------------------------------------------------------------------------------------------

interface View { id: string; title: string; start: string; end: string; allDay: boolean; status?: string; location?: string; readOnly: boolean; recurring: boolean }
const list = async (h: Awaited<ReturnType<typeof harness>>, args: Record<string, string>) => ((await h.service.list({ calendar: "Work", ...args })) as { events: View[] }).events;
const occurrence = (item: Record<string, unknown>, zone = "Europe/Amsterdam") => toOccurrence(item as unknown as IntakeItem, zone);

test("timed events are shown in the household zone", async () => {
  const intake = new FakeIntake();
  intake.deliver([meeting("Quick check-in", "2026-09-11T13:00:00+00:00", "2026-09-11T13:20:00+00:00")], "2026-10-03T07:00:00Z");
  const h = await workHarness(intake);
  await h.work.poll();
  const [e] = await list(h, { from: "2026-09-11", to: "2026-09-11" });
  assert.equal(e.start, "2026-09-11T15:00:00+02:00");
  assert.equal(e.end, "2026-09-11T15:20:00+02:00");
  assert.equal(e.recurring, false);
  assert.equal(e.readOnly, true);
});

test("all-day events keep their dates as written, whatever the household zone", async () => {
  const intake = new FakeIntake();
  intake.deliver([allDayItem("BLOCKED", "2026-12-15", "2026-12-16")], "2026-10-03T07:00:00Z");
  const h = await harness(HOME_FAMILY(), { intake, zone: "America/New_York" });
  await h.work.poll();
  const events = await list(h, { from: "2026-12-14", to: "2026-12-16" });
  assert.deepEqual(events.map((e) => [e.allDay, e.start, e.end]), [[true, "2026-12-15", "2026-12-15"]]);
  // An end that isn't after the start still makes one day.
  assert.equal(occurrence(allDayItem("x", "2026-12-15", "2026-12-15")).endDate, "2026-12-16");
});

test("cancelled, tentative, free and out-of-office meetings carry a status", () => {
  const at = (subject: string, showAs: string) => occurrence(meeting(subject, "2026-10-05T07:30:00+00:00", "2026-10-05T08:00:00+00:00", { showAs }));
  const interview = at("Geannuleerd: Interview SBP - Renske", "free");
  assert.deepEqual([interview.title, interview.status], ["Interview SBP - Renske", "cancelled"]);
  assert.equal(at("Canceled: Sync", "busy").status, "cancelled");
  assert.equal(at("CANCELLED:Sync", "busy").title, "Sync");
  assert.equal(at("Sync", "tentative").status, "tentative");
  assert.equal(at("Sync", "free").status, "free");
  assert.equal(at("Away", "oof").status, "out of office");
  assert.equal(at("Sync", "busy").status, undefined);
  assert.equal(at("Sync", "workingElsewhere").status, undefined);
});

test("online meetings say online, rooms keep their names without the underscore", () => {
  assert.equal(workLocation("Microsoft Teams Meeting; _Video Conference; SkyLounge"), "online, Video Conference, SkyLounge");
  assert.equal(workLocation("https://rijksvideo.webex.com/rijksvideo/j.php?MTID=m35d5de98a2ad14c385"), "online");
  assert.equal(workLocation("Microsoft Teams Meeting"), "online");
  assert.equal(workLocation("microsoft teams meeting; Room with a View"), "online, Room with a View");
  assert.equal(workLocation("Microsoft Teams Meeting; _Space; _Captains Table; Boeing Avenue 271, Schiphol-Rijk"), "online, Space, Captains Table, Boeing Avenue 271, Schiphol-Rijk");
  assert.equal(workLocation("__Room"), "Room");
  assert.equal(workLocation("Apeldoorn (J.F. Kennedylaan 8), zaal volgt"), "Apeldoorn (J.F. Kennedylaan 8), zaal volgt");
  assert.equal(workLocation(""), undefined);
  assert.equal(workLocation(" ; "), undefined);
  assert.equal(workLocation(undefined), undefined);
});

test("listed work events carry the mapped title, status and location", async () => {
  const h = await workHarness(new FakeIntake().load("v3"));
  await h.work.poll();
  const events = await list(h, { from: "2026-10-05", to: "2026-10-08" });
  assert.deepEqual(
    events.map((e) => [e.title, e.status, e.location]),
    [
      ["Team Standup", undefined, "online"],
      ["Quarterly planning", "tentative", "online, Video Conference, SkyLounge"],
      ["Interview candidate", "cancelled", "online"],
      ["BLOCKED", "free", undefined],
      ["Site visit", undefined, "Apeldoorn (Kennedylaan 8), room to follow"],
    ],
  );
});

test("an event's id survives a new snapshot that has it unchanged", async () => {
  const intake = new FakeIntake();
  const standup = meeting("Team Standup", "2026-10-05T07:30:00+00:00", "2026-10-05T07:45:00+00:00");
  intake.deliver([standup], "2026-10-03T07:00:00Z");
  const h = await workHarness(intake);
  await h.work.poll();
  const [before] = await list(h, { from: "2026-10-05", to: "2026-10-05" });
  intake.deliver([meeting("New meeting", "2026-10-05T09:00:00+00:00", "2026-10-05T10:00:00+00:00"), standup], "2026-10-03T08:00:00Z");
  await h.work.poll();
  const after = await list(h, { from: "2026-10-05", to: "2026-10-05" });
  assert.equal(after.find((e) => e.title === "Team Standup")?.id, before.id);
});
