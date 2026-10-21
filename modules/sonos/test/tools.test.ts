import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestHost } from "@friday/sdk/test";
import { createSonosModule } from "../src/index.js";
import { ARC, ARC_NAME, env, fakeHa, household } from "./fake-ha.js";

test("sonos_list_speakers adds what is playing", async () => {
  const rows = household();
  Object.assign(rows[0], { state: "playing", title: "Karma Police", artist: "Radiohead" });
  const ha = fakeHa(rows);
  const h = await createTestHost(createSonosModule({ fetch: ha.fetch }), { env });
  const { result } = await h.call("sonos_list_speakers");
  const speakers = result.speakers as Record<string, unknown>[];
  assert.deepEqual(speakers[0], {
    name: ARC_NAME,
    area: "Living Room",
    model: "Arc",
    entity: ARC,
    state: "playing",
    volume: 16,
    playing: { title: "Karma Police", artist: "Radiohead" },
  });
  assert.equal(speakers.length, 3);
  assert.equal(ha.calls.length, 0);
});

test("sonos_list_speakers leaves out a title when nothing is playing or paused", async () => {
  const rows = household();
  Object.assign(rows[0], { state: "idle", title: "Old" });
  const h = await createTestHost(createSonosModule({ fetch: fakeHa(rows).fetch }), { env });
  const { result } = await h.call("sonos_list_speakers");
  assert.equal((result.speakers as Record<string, unknown>[])[0].playing, undefined);
});

test("sonos_list_speakers returns an empty list when the integration has no entities", async () => {
  const h = await createTestHost(createSonosModule({ fetch: fakeHa([]).fetch }), { env });
  assert.deepEqual((await h.call("sonos_list_speakers")).result, { speakers: [] });
});

test("an unreachable Home Assistant fails as a speaker lookup error without the token", async () => {
  const down = (async () => {
    throw new TypeError("fetch failed");
  }) as typeof fetch;
  const h = await createTestHost(createSonosModule({ fetch: down }), { env });
  for (const [tool, args] of [["sonos_list_speakers", {}], ["sonos_pause", { speakers: ["Bedroom"] }]] as const) {
    const r = await h.call(tool, args);
    assert.match(String(r.result.error), /Sonos speaker lookup failed: home assistant template failed: fetch failed/);
    assert.doesNotMatch(String(r.result.error), /ha-secret-token/);
    assert.equal(r.scheduling, "INTERRUPT");
  }
});

test("the module registers exactly the seven sonos tools", async () => {
  const h = await createTestHost(createSonosModule({ fetch: fakeHa().fetch }), { env });
  assert.deepEqual(h.tools, ["sonos_list_speakers", "sonos_play", "sonos_pause", "sonos_resume", "sonos_stop", "sonos_set_volume", "sonos_ungroup"]);
});

test("the descriptions say artists aren't accepted, rooms work, and pause acts on the group", async () => {
  const h = await createTestHost(createSonosModule({ fetch: fakeHa().fetch }), { env });
  const decl = (name: string) => h.registry.declarations("voice").find((d) => d.name === name)!;
  assert.match(decl("sonos_play").description, /Artist URIs are not accepted/);
  assert.match(decl("sonos_pause").description, /whole group/);
  assert.match(decl("sonos_set_volume").description, /individually/);
  assert.match(JSON.stringify(decl("sonos_play").parameters), /the room you are in/);
});

test("the tools are offered on voice and chat", async () => {
  const h = await createTestHost(createSonosModule({ fetch: fakeHa().fetch }), { env });
  assert.deepEqual(h.toolsIn("voice"), h.tools);
  assert.deepEqual(h.toolsIn("chat"), h.tools);
});
