import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestHost } from "@friday/sdk/test";
import { createSimracingModule, MockTelemetrySource } from "../src/index.js";

test("every tool answers with mock telemetry", async () => {
  const h = await createTestHost(createSimracingModule(new MockTelemetrySource()));
  assert.deepEqual(h.tools, ["get_race_position", "get_gap_ahead", "get_gap_behind", "get_fuel_remaining", "get_lap_info"]);
  assert.deepEqual((await h.call("get_race_position")).result, { position: 4, cars: 20, session: "race" });
  assert.deepEqual((await h.call("get_gap_ahead")).result, { gap_s: 1.8, driver: "M. Verstappen" });
  assert.deepEqual((await h.call("get_gap_behind")).result, { gap_s: 0.6, driver: "L. Norris" });
  assert.deepEqual((await h.call("get_fuel_remaining")).result, { fuel_litres: 31.4, laps_of_fuel: 10, laps_remaining: 14, enough_to_finish: false });
  assert.deepEqual((await h.call("get_lap_info")).result, { lap: 12, total_laps: 25, last_lap: "1:32.412", best_lap: "1:31.877", track: "Spa-Francorchamps", car: "Porsche 992 GT3 R" });
});

test("leading and last positions have no gaps", async () => {
  const src = new MockTelemetrySource({ ...MockTelemetrySource.sample(), gapAheadS: undefined, gapBehindS: undefined });
  const h = await createTestHost(createSimracingModule(src));
  assert.deepEqual((await h.call("get_gap_ahead")).result, { leading: true });
  assert.deepEqual((await h.call("get_gap_behind")).result, { last: true });
});

test("no session gives the same error for every tool", async () => {
  const h = await createTestHost(createSimracingModule(new MockTelemetrySource(null)));
  for (const t of h.tools) assert.deepEqual(await h.call(t), { result: { error: "not in a session" }, scheduling: "INTERRUPT" });
});
