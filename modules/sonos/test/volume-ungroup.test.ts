import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestHost } from "@friday/sdk/test";
import { createSonosModule } from "../src/index.js";
import { ARC, ARC_NAME, ONE_SL, ONE_SL_NAME, PLAYBAR, PLAYBAR_NAME, env, fakeHa, grouped, household, type Row } from "./fake-ha.js";

async function host(rows: Row[] = household()) {
  const ha = fakeHa(rows);
  const h = await createTestHost(createSonosModule({ fetch: ha.fetch }), { env });
  return { ha, h };
}

test("grouped speakers get their volume set individually", async () => {
  const { ha, h } = await host(grouped(household(), ARC, ONE_SL));
  const r = await h.call("sonos_set_volume", { speakers: ["Living Room", "Hobby Room"], volume: 30 });
  assert.deepEqual(r.result, { volume: 30, speakers: [ARC_NAME, ONE_SL_NAME] });
  assert.equal(r.scheduling, "SILENT");
  // One volume_set listing both: HA sets the level on each entity, not on the group.
  assert.deepEqual(ha.calls, [{ service: "media_player.volume_set", data: { entity_id: [ARC, ONE_SL], volume_level: 0.3 } }]);
});

test("a fractional volume is rounded", async () => {
  const { ha, h } = await host();
  const r = await h.call("sonos_set_volume", { speakers: ["Bedroom"], volume: 24.6 });
  assert.equal(r.result.volume, 25);
  assert.deepEqual(ha.calls[0].data, { entity_id: [PLAYBAR], volume_level: 0.25 });
});

test("a volume out of range is refused before Home Assistant is asked anything", async () => {
  const { ha, h } = await host();
  for (const volume of [120, -1, "loud"]) {
    assert.match(String((await h.call("sonos_set_volume", { speakers: ["Bedroom"], volume })).result.error), /Volume must be a number from 0 to 100/);
  }
  assert.equal(ha.requests.length, 0);
});

test("ungrouping without speakers takes every member out of its group", async () => {
  const { ha, h } = await host(grouped(household(), ARC, ONE_SL, PLAYBAR));
  const r = await h.call("sonos_ungroup", {});
  assert.deepEqual(r.result, { ungrouped: [PLAYBAR_NAME, ONE_SL_NAME] });
  assert.equal(r.scheduling, "SILENT");
  assert.deepEqual(ha.calls, [{ service: "media_player.unjoin", data: { entity_id: [PLAYBAR, ONE_SL] } }]);
});

test("an empty speakers list ungroups everything, like leaving it out", async () => {
  const { ha, h } = await host(grouped(household(), ARC, ONE_SL));
  assert.deepEqual((await h.call("sonos_ungroup", { speakers: [] })).result, { ungrouped: [ONE_SL_NAME] });
  assert.deepEqual(ha.calls, [{ service: "media_player.unjoin", data: { entity_id: [ONE_SL] } }]);
});

test("ungrouping when nothing is grouped calls nothing", async () => {
  const { ha, h } = await host();
  assert.deepEqual((await h.call("sonos_ungroup", {})).result, { ungrouped: [] });
  assert.deepEqual((await h.call("sonos_ungroup", { speakers: ["Bedroom"] })).result, { ungrouped: [] });
  assert.equal(ha.calls.length, 0);
});

test("ungrouping one named member takes only that one out", async () => {
  const { ha, h } = await host(grouped(household(), ARC, ONE_SL, PLAYBAR));
  const r = await h.call("sonos_ungroup", { speakers: ["Hobby Room"] });
  assert.deepEqual(r.result, { ungrouped: [ONE_SL_NAME] });
  assert.deepEqual(ha.calls, [{ service: "media_player.unjoin", data: { entity_id: [ONE_SL] } }]);
});
