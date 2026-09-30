import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestHost } from "@friday/sdk/test";
import builtin from "../src/index.js";

test("module exposes the three builtin tools", async () => {
  const h = await createTestHost(builtin);
  assert.deepEqual(h.tools, ["get_current_time", "set_timer", "end_conversation"]);
  assert.equal(builtin.manifest.id, "builtin");
});

test("set_timer and end_conversation are voice-only; get_current_time is offered in both", async () => {
  const h = await createTestHost(builtin);
  assert.deepEqual(h.toolsIn("voice"), ["get_current_time", "set_timer", "end_conversation"]);
  assert.deepEqual(h.toolsIn("chat"), ["get_current_time"]);
});

test("the end_conversation description says not to call it when the final words are a question", async () => {
  const h = await createTestHost(builtin);
  const d = h.registry.declarations("voice").find((t) => t.name === "end_conversation");
  assert.match(String(d?.description), /Never call it when your final words are a question or invite the user to talk/);
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

test("get_current_time: an invalid configured zone answers in Europe/Amsterdam and warns once", async () => {
  const lines: string[] = [];
  const push = (...a: unknown[]) => void lines.push(a.join(" "));
  const h = await createTestHost(builtin, { env: { FRIDAY_TIMEZONE: "Mars/Olympus" }, log: { log: push, warn: push, error: push } });

  const r = await h.call("get_current_time");
  await h.call("get_current_time");

  assert.equal(r.result.timezone, "Europe/Amsterdam");
  assert.equal(typeof r.result.human, "string");
  assert.equal(lines.filter((l) => l.includes("Mars/Olympus")).length, 1);
});

test("get_current_time: an explicit zone is trimmed, and a blank one means the household zone", async () => {
  const h = await createTestHost(builtin, { env: { FRIDAY_TIMEZONE: "Asia/Tokyo" } });
  assert.equal((await h.call("get_current_time", { timezone: " America/New_York " })).result.timezone, "America/New_York");
  assert.equal((await h.call("get_current_time", { timezone: "  " })).result.timezone, "Asia/Tokyo");
});

test("get_current_time: an invalid explicit zone is an error naming it", async () => {
  const h = await createTestHost(builtin);
  const r = await h.call("get_current_time", { timezone: "Mars/Olympus" });
  assert.match(String(r.result.error), /Mars\/Olympus/);
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
