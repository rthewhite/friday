import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestHost } from "@friday/sdk/test";
import { createCalendarModule } from "../src/index.js";
import { FakeICloud, PASSWORD, USERNAME, timed, vcalendar } from "./fake-icloud.js";
import { NOW } from "./harness.js";

const now = () => new Date(NOW);

test("the module fails without ICLOUD_APP_PASSWORD, naming it", async () => {
  await assert.rejects(createTestHost(createCalendarModule(), { env: { ICLOUD_USERNAME: "me@icloud.com" } }), /ICLOUD_APP_PASSWORD/);
});

test("the module fails without ICLOUD_USERNAME, naming it", async () => {
  await assert.rejects(createTestHost(createCalendarModule(), { env: { ICLOUD_APP_PASSWORD: "abcd-efgh-ijkl-mnop" } }), /ICLOUD_USERNAME/);
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
