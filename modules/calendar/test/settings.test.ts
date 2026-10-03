import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryStorage } from "@friday/sdk";
import type { CalendarInfo } from "../src/caldav.js";
import { InputError } from "../src/errors.js";
import { Settings } from "../src/settings.js";

const CALS: CalendarInfo[] = [
  { id: "holidays", url: "h", name: "Holidays NL", writable: false },
  { id: "home", url: "a", name: "Home", writable: true },
  { id: "work", url: "b", name: "Work", writable: true },
];

async function fresh(storage = new MemoryStorage()) {
  const s = new Settings(storage);
  await s.load();
  return { s, storage };
}

test("calendars default to used and in the agenda", async () => {
  const { s } = await fresh();
  assert.deepEqual(s.of("work"), { use: true, inAgenda: true });
  assert.deepEqual(s.used(CALS).map((c) => c.id), ["holidays", "home", "work"]);
});

test("without a default, new events go to the first used, writable calendar", async () => {
  const { s } = await fresh();
  assert.equal(s.defaultCalendar(CALS)?.id, "home");
});

test("settings are saved and survive a reload from storage", async () => {
  const { s, storage } = await fresh();
  await s.update({ calendars: { work: { inAgenda: false } }, defaultId: "work" }, CALS);
  const { s: again } = await fresh(storage);
  assert.deepEqual(again.of("work"), { use: true, inAgenda: false });
  assert.equal(again.defaultCalendar(CALS)?.id, "work");
  assert.deepEqual(again.inAgenda(CALS).map((c) => c.id), ["holidays", "home"]);
});

test("a default that is no longer used falls back to the first used, writable calendar", async () => {
  const { s, storage } = await fresh();
  await s.update({ defaultId: "work" }, CALS);
  // Stored directly, as if the calendar was turned off by an older version or by hand.
  await storage.set("settings", { calendars: { work: { use: false, inAgenda: true } }, defaultId: "work" });
  await s.load();
  assert.equal(s.defaultCalendar(CALS)?.id, "home");
  assert.deepEqual(s.used(CALS).map((c) => c.id), ["holidays", "home"]);
});

test("updates refuse unknown ids, bad flags, read-only defaults and turning off the default", async () => {
  const { s } = await fresh();
  await assert.rejects(s.update({ calendars: { nope: { use: false } } }, CALS), (e: unknown) => e instanceof InputError && /unknown calendar id "nope"/.test(e.message));
  await assert.rejects(s.update({ calendars: { work: { use: "no" } } }, CALS), InputError);
  await assert.rejects(s.update({ defaultId: "holidays" }, CALS), (e: unknown) => e instanceof InputError && /read-only/.test(e.message));
  await assert.rejects(s.update({ defaultId: "missing" }, CALS), InputError);
  await s.update({ defaultId: "work" }, CALS);
  await assert.rejects(s.update({ calendars: { work: { use: false } } }, CALS), /has to use it/);
  await assert.rejects(s.update([], CALS), InputError);
  // Nothing refused was stored.
  assert.deepEqual(s.of("work"), { use: true, inAgenda: true });
  assert.equal(s.defaultId, "work");
});

test("the default can be cleared", async () => {
  const { s } = await fresh();
  await s.update({ defaultId: "work" }, CALS);
  await s.update({ defaultId: null }, CALS);
  assert.equal(s.defaultId, undefined);
  assert.equal(s.defaultCalendar(CALS)?.id, "home");
});
