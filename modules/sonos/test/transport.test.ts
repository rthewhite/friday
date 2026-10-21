import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestHost } from "@friday/sdk/test";
import { createSonosModule } from "../src/index.js";
import { ARC, ARC_NAME, ONE_SL_NAME, PLAYBAR, PLAYBAR_NAME, ONE_SL, env, fakeHa, grouped, household, type Row } from "./fake-ha.js";

async function host(rows: Row[] = household()) {
  const ha = fakeHa(rows);
  const h = await createTestHost(createSonosModule({ fetch: ha.fetch }), { env });
  return { ha, h };
}

test("pausing a group member pauses its leader once and names the whole group", async () => {
  const { ha, h } = await host(grouped(household(), ARC, ONE_SL));
  const r = await h.call("sonos_pause", { speakers: ["Hobby Room"] });
  assert.deepEqual(r.result, { paused: [ARC_NAME, ONE_SL_NAME] });
  assert.equal(r.scheduling, "SILENT");
  assert.deepEqual(ha.calls, [{ service: "media_player.media_pause", data: { entity_id: ARC } }]);
});

test("two speakers in one group get one stop, sent to the leader", async () => {
  const { ha, h } = await host(grouped(household(), ARC, ONE_SL));
  const r = await h.call("sonos_stop", { speakers: ["Hobby Room", "Living Room"] });
  assert.deepEqual(r.result, { stopped: [ARC_NAME, ONE_SL_NAME] });
  assert.deepEqual(ha.calls, [{ service: "media_player.media_stop", data: { entity_id: ARC } }]);
});

test("resume sends play to the speaker", async () => {
  const { ha, h } = await host();
  const r = await h.call("sonos_resume", { speakers: ["Bedroom"] });
  assert.deepEqual(r.result, { resumed: [PLAYBAR_NAME] });
  assert.deepEqual(ha.calls, [{ service: "media_player.media_play", data: { entity_id: PLAYBAR } }]);
});

test("speakers in different groups each get the command", async () => {
  const { ha, h } = await host();
  await h.call("sonos_pause", { speakers: ["Bedroom", "Living Room"] });
  assert.deepEqual(ha.calls.map((c) => c.data.entity_id), [PLAYBAR, ARC]);
});

test("pause needs a speaker and an unknown one changes nothing", async () => {
  const { ha, h } = await host();
  assert.match(String((await h.call("sonos_pause", { speakers: [] })).result.error), /Name at least one Sonos speaker/);
  assert.match(String((await h.call("sonos_pause", { speakers: ["Garage"] })).result.error), /"Garage"/);
  assert.equal(ha.calls.length, 0);
});
