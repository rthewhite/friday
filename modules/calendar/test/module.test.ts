import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestHost } from "@friday/sdk/test";
import { createCalendarModule } from "../src/index.js";
import { FakeICloud, PASSWORD, USERNAME, timed, vcalendar } from "./fake-icloud.js";
import { FakeIntake, INTAKE_KEY, INTAKE_URL } from "./fake-intake.js";
import { NOW } from "./harness.js";

const now = () => new Date(NOW);

test("the module fails without ICLOUD_APP_PASSWORD, naming it", async () => {
  await assert.rejects(createTestHost(createCalendarModule(), { env: { ICLOUD_USERNAME: "me@icloud.com" } }), /ICLOUD_APP_PASSWORD/);
});

test("the module fails without ICLOUD_USERNAME, naming it", async () => {
  await assert.rejects(createTestHost(createCalendarModule(), { env: { ICLOUD_APP_PASSWORD: "abcd-efgh-ijkl-mnop" } }), /ICLOUD_USERNAME/);
});

test("with no source configured the module fails, naming the missing keys", async () => {
  await assert.rejects(createTestHost(createCalendarModule(), { env: {} }), (e: Error) => ["ICLOUD_USERNAME", "ICLOUD_APP_PASSWORD", "INTAKE_URL", "INTAKE_KEY"].every((k) => e.message.includes(k)));
  // Half of each pair is still nothing usable.
  await assert.rejects(createTestHost(createCalendarModule(), { env: { ICLOUD_USERNAME: USERNAME, INTAKE_URL } }), /ICLOUD_APP_PASSWORD.*INTAKE_KEY/);
});

test("with only the intake keys the module loads with all six tools and lists only the Work calendar", async () => {
  const icloud = new FakeICloud();
  const intake = new FakeIntake();
  const host = await createTestHost(createCalendarModule({ fetch: icloud.fetch, intakeFetch: intake.fetch, now }), { env: { INTAKE_URL, INTAKE_KEY } });
  assert.equal(host.tools.filter((t) => t.startsWith("calendar_")).length, 6);
  const r = await host.call("calendar_list_events", { calendar: "Home" });
  assert.match(String((r.result as { error: string }).error), /The calendars are: "Work"\./);
  assert.equal(icloud.requests.length, 0);
  await host.dispose();
});

test("with both keys the module offers all six tools on voice and chat", async () => {
  const host = await createTestHost(createCalendarModule({ fetch: new FakeICloud().fetch, now }), { env: { ICLOUD_USERNAME: USERNAME, ICLOUD_APP_PASSWORD: PASSWORD } });
  const tools = ["calendar_list_events", "calendar_create_event", "calendar_update_event", "calendar_delete_event", "calendar_confirm", "calendar_undo"];
  assert.deepEqual([...host.tools].sort(), [...tools].sort());
  for (const channel of ["voice", "chat"] as const) assert.deepEqual(host.toolsIn(channel).filter((t) => t.startsWith("calendar_")).sort(), [...tools].sort());
  await host.dispose();
});

test("a rejected password is reported, and a newly saved one works without a reload", async () => {
  const fake = new FakeICloud();
  fake.seed("home", "swim", vcalendar(timed("swim", "Swimming lesson", "20261003T100000", "20261003T110000")));
  const env: Record<string, string> = { ICLOUD_USERNAME: USERNAME, ICLOUD_APP_PASSWORD: "my-apple-id-password" };
  const host = await createTestHost(createCalendarModule({ fetch: fake.fetch, now }), { env });
  const first = await host.call("calendar_list_events", { from: "2026-10-03", to: "2026-10-03" });
  const message = String((first.result as { error: string }).error);
  assert.match(message, /app-specific password/);
  assert.ok(!message.includes("my-apple-id-password"));
  env.ICLOUD_APP_PASSWORD = PASSWORD;
  const second = await host.call("calendar_list_events", { from: "2026-10-03", to: "2026-10-03" });
  assert.deepEqual((second.result as { events: { title: string }[] }).events.map((e) => e.title), ["Swimming lesson"]);
  await host.dispose();
});
