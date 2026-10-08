import { test } from "node:test";
import assert from "node:assert/strict";
import { splitAlerts, stateTone, targetText, timeLeft, type AlertRecord } from "../src/lib/alerts.ts";

const alert = (over: Partial<AlertRecord>): AlertRecord => ({
  id: "k3f9",
  kind: "timer",
  label: "eggs",
  dueAt: "2026-10-08T10:05:00.000Z",
  target: { kind: "device", id: "friday-kitchen", label: "Kitchen satellite" },
  state: "scheduled",
  createdAt: "2026-10-08T10:00:00.000Z",
  finishedAt: null,
  rings: 0,
  ...over,
});

test("active alerts (scheduled, ringing) and finished ones are shown apart, keeping the API's order", () => {
  const list = [alert({ id: "a" }), alert({ id: "b", state: "ringing" }), alert({ id: "c", state: "missed" }), alert({ id: "d", state: "acknowledged" }), alert({ id: "e", state: "cancelled" })];
  const { active, finished } = splitAlerts(list);
  assert.deepEqual(active.map((a) => a.id), ["a", "b"]);
  assert.deepEqual(finished.map((a) => a.id), ["c", "d", "e"]);
});

test("time left reads naturally, and a due alert is ringing", () => {
  const due = "2026-10-08T10:05:00.000Z", at = (iso: string) => Date.parse(iso);
  assert.equal(timeLeft(due, at("2026-10-08T10:00:30Z")), "4 min 30 s");
  assert.equal(timeLeft(due, at("2026-10-08T10:00:00Z")), "5 min");
  assert.equal(timeLeft(due, at("2026-10-08T10:04:15Z")), "45 s");
  assert.equal(timeLeft("2026-10-08T11:05:00.000Z", at("2026-10-08T10:00:00Z")), "1 h 5 min");
  assert.equal(timeLeft(due, at("2026-10-08T10:05:00Z")), "ringing");
});

test("missed alerts stand out, and a deleted device shows by its id", () => {
  assert.equal(stateTone.missed, "error");
  assert.notEqual(stateTone.acknowledged, "error");
  assert.equal(targetText(alert({})), "Kitchen satellite");
  assert.equal(targetText(alert({ target: { kind: "device", id: "friday-old" } })), "friday-old");
});
