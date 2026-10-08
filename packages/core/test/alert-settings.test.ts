import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { alertSettings } from "../src/config.js";

test("alert settings default to 5 rings a minute apart and a 10 minute grace limit", () => {
  assert.deepEqual(alertSettings({}), { alertRings: 5, alertRingIntervalMs: 60_000, alertGraceMs: 600_000 });
});

test("alert settings read the environment, and invalid values fall back to the defaults", () => {
  assert.deepEqual(
    alertSettings({ FRIDAY_ALERT_RINGS: "3", FRIDAY_ALERT_RING_INTERVAL_MS: "30000", FRIDAY_ALERT_GRACE_MS: "300000" }),
    { alertRings: 3, alertRingIntervalMs: 30_000, alertGraceMs: 300_000 },
  );
  assert.deepEqual(alertSettings({ FRIDAY_ALERT_RINGS: "0", FRIDAY_ALERT_RING_INTERVAL_MS: "soon", FRIDAY_ALERT_GRACE_MS: "-1" }), alertSettings({}));
});

test("the alert settings are documented in .env.example", () => {
  const example = readFileSync(new URL("../../../.env.example", import.meta.url), "utf8");
  for (const key of ["FRIDAY_ALERT_RINGS=5", "FRIDAY_ALERT_RING_INTERVAL_MS=60000", "FRIDAY_ALERT_GRACE_MS=600000"]) assert.ok(example.includes(key), key);
});
