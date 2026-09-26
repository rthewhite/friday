import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestHost } from "@friday/sdk/test";
import builtin from "../src/index.js";

test("module exposes the three builtin tools", async () => {
  const h = await createTestHost(builtin);
  assert.deepEqual(h.tools, ["get_current_time", "set_timer", "end_conversation"]);
  assert.equal(builtin.manifest.id, "builtin");
});

test("get_current_time: default zone, configured zone, explicit zone", async () => {
  const h = await createTestHost(builtin);
  const d = await h.call("get_current_time");
  assert.equal(d.result.timezone, "Europe/Amsterdam");
  assert.match(String(d.result.iso), /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(typeof d.result.human, "string");

  const c = await createTestHost(builtin, { env: { FRIDAY_TIMEZONE: "Asia/Tokyo" } });
  assert.equal((await c.call("get_current_time")).result.timezone, "Asia/Tokyo");

  const e = await h.call("get_current_time", { timezone: "America/New_York" });
  assert.equal(e.result.timezone, "America/New_York");
  assert.equal(e.scheduling, "INTERRUPT");
});

test("set_timer waits and reports WHEN_IDLE", async () => {
  const h = await createTestHost(builtin);
  const t0 = Date.now();
  const r = await h.call("set_timer", { seconds: 0.05, label: "eggs" });
  assert.ok(Date.now() - t0 >= 45);
  assert.deepEqual(r, { result: { done: true, label: "eggs", message: "eggs finished after 0.05 seconds" }, scheduling: "WHEN_IDLE" });
  const d = await h.call("set_timer", { seconds: 0 });
  assert.equal(d.result.label, "timer");
});

test("end_conversation returns ending + reason to the model and endConversation to the session", async () => {
  const h = await createTestHost(builtin);
  assert.deepEqual(await h.call("end_conversation", { reason: "user said goodbye" }), {
    result: { ending: true, reason: "user said goodbye" },
    scheduling: "SILENT",
    endConversation: "user said goodbye",
  });
  const d = await h.call("end_conversation");
  assert.equal(d.result.reason, "done");
  assert.equal(d.endConversation, "done");
});
