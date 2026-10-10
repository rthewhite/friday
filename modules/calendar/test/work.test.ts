import { test } from "node:test";
import assert from "node:assert/strict";
import { InputError } from "../src/errors.js";
import { WORK_CALENDAR_ID } from "../src/work.js";
import { FakeICloud } from "./fake-icloud.js";
import { FakeIntake } from "./fake-intake.js";
import { harness } from "./harness.js";

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
