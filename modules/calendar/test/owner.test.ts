import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestHost } from "@friday/sdk/test";
import { createCalendarModule } from "../src/index.js";
import { isOwnerOnly, ApiError } from "../src/ui/lib/calendar.js";
import { FakeICloud, PASSWORD, USERNAME, timed, vcalendar } from "./fake-icloud.js";
import { NOW } from "./harness.js";

const raymond = { id: "u1", name: "Raymond" };
const sanne = { id: "u2", name: "Sanne" };

async function household() {
  const fake = new FakeICloud();
  fake.seed("home", "dentist", vcalendar(timed("dentist", "Dentist", "20261003T140000", "20261003T150000")));
  const host = await createTestHost(createCalendarModule({ fetch: fake.fetch, now: () => new Date(NOW) }), {
    env: { ICLOUD_USERNAME: USERNAME, ICLOUD_APP_PASSWORD: PASSWORD },
    users: [raymond, sanne],
    owner: "u1",
  });
  await host.runJob("refresh");
  return host;
}

test("a member's prompt holds no agenda and their turn offers no calendar tools; the owner's do", async () => {
  const h = await household();
  assert.equal(h.promptContext("chat", sanne), "");
  assert.match(h.promptContext("chat", raymond), /14:00-15:00: Dentist/);
  assert.match(h.promptContext("voice"), /Dentist/, "a device's session is held for the owner");
  assert.deepEqual(h.toolsIn("chat", sanne), []);
  assert.ok(h.toolsIn("chat", raymond).includes("calendar_list_events"));
  const forced = await h.call("calendar_list_events", { from: "2026-10-03" }, { channel: "chat", user: sanne });
  assert.deepEqual(forced.result, { error: "calendar_list_events is only available to the household owner" });
  await h.dispose();
});

test("a member opening the Calendar page gets 403 on every route, and the page shows it is the owner's", async () => {
  const h = await household();
  const member = { user: { ...sanne, role: "admin" as const } };
  for (const [method, path] of [["GET", "status"], ["POST", "refresh"], ["GET", "changes"], ["PUT", "settings"]] as const) {
    const r = await h.request(method, path, {}, {}, member);
    assert.equal(r.status, 403, `${method} ${path}`);
    assert.deepEqual(r.body, { error: "the calendar belongs to the household owner", code: "owner_only" });
  }
  assert.equal((await h.request("GET", "status", undefined, {}, { user: { ...raymond, role: "member" } })).status, 200);
  assert.equal(isOwnerOnly(new ApiError(403, "the calendar belongs to the household owner", {})), true);
  assert.equal(isOwnerOnly(new ApiError(409, "x", {})), false);
  await h.dispose();
});
