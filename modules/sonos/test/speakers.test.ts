import { test } from "node:test";
import assert from "node:assert/strict";
import { loadSpeakers, parseSpeakers, resolve, view, type Speaker } from "../src/speakers.js";
import type { HaClient } from "../src/ha.js";
import { ARC, ARC_NAME, ONE_SL, ONE_SL_NAME, PLAYBAR, PLAYBAR_NAME, grouped, household, type Row } from "./fake-ha.js";

const parse = (rows: Row[]): Speaker[] => parseSpeakers(JSON.stringify(rows));
const names = (s: Speaker[]) => s.map((x) => x.name);

test("speakers are parsed with volume 0-100 and the group by name, leader first", () => {
  const all = parse(grouped(household(), ARC, ONE_SL));
  const arc = all.find((s) => s.entity === ARC)!;
  assert.deepEqual(view(arc, all), { name: ARC_NAME, area: "Living Room", model: "Arc", entity: ARC, state: "idle", volume: 16, group: [ARC_NAME, ONE_SL_NAME] });
  assert.deepEqual(view(all.find((s) => s.entity === ONE_SL)!, all).group, [ARC_NAME, ONE_SL_NAME]);
  assert.equal(view(all.find((s) => s.entity === PLAYBAR)!, all).group, undefined);
});

test("missing area, model and volume are omitted", () => {
  const [s] = parse([{ entity: "media_player.x", name: "X", area: null, model: null, state: "unavailable", volume: null, group: null, title: null, artist: null }]);
  assert.deepEqual(view(s, [s]), { name: "X", entity: "media_player.x", state: "unavailable" });
});

test("only what the template returns are speakers: a group entity is never among them", async () => {
  // The template selects integration_entities('sonos'); the parser trusts it and adds nothing.
  const rows = household();
  const all = await loadSpeakers({ template: async () => JSON.stringify(rows), call: async () => [] });
  assert.deepEqual(all.map((s) => s.entity), [ARC, PLAYBAR, ONE_SL]);
  assert.ok(!all.some((s) => s.entity === "media_player.all_speakers"));
});

test("every call reads the speakers fresh, so a speaker added in Home Assistant shows up", async () => {
  const rows = household();
  const ha: HaClient = { template: async () => JSON.stringify(rows), call: async () => [] };
  assert.equal((await loadSpeakers(ha)).length, 3);
  rows.push({ entity: "media_player.kitchen", name: "Kitchen", area: "Kitchen", model: "Era 100", state: "idle", volume: 0.2, group: ["media_player.kitchen"], title: null, artist: null });
  assert.equal((await loadSpeakers(ha)).length, 4);
});

test("a malformed template response fails as a lookup error", async () => {
  await assert.rejects(loadSpeakers({ template: async () => "<html>", call: async () => [] }), /Sonos speaker lookup failed: .*not JSON|other than JSON/);
  await assert.rejects(loadSpeakers({ template: async () => '{"a":1}', call: async () => [] }), /Sonos speaker lookup failed: .*not return a list/);
  await assert.rejects(loadSpeakers({ template: async () => { throw new Error("home assistant template -> 500 x"); }, call: async () => [] }), /Sonos speaker lookup failed: home assistant template -> 500/);
});

test("a reference matches by area, case-insensitively", () => {
  assert.deepEqual(names(resolve(["bedroom"], parse(household()))), [PLAYBAR_NAME]);
});

test("a reference matches by name, ignoring punctuation", () => {
  assert.deepEqual(names(resolve(["hobby room sonos"], parse(household()))), [ONE_SL_NAME]);
});

test("a reference matches by entity id, with or without the domain", () => {
  const all = parse(household());
  assert.deepEqual(names(resolve([ARC], all)), [ARC_NAME]);
  assert.deepEqual(names(resolve(["sonos_arc"], all)), [ARC_NAME]);
});

test("an area matches every speaker in it", () => {
  const rows = household();
  rows[2].area = "Living Room";
  assert.deepEqual(names(resolve(["living room"], parse(rows))), [ARC_NAME, ONE_SL_NAME]);
});

test("a name beats an area of the same name", () => {
  const rows = household();
  rows[2].name = "Bedroom";
  assert.deepEqual(names(resolve(["Bedroom"], parse(rows))), ["Bedroom"]);
});

test("speakers are used once, in first-referenced order", () => {
  assert.deepEqual(names(resolve(["Hobby Room", "Living Room", "hobby room"], parse(household()))), [ONE_SL_NAME, ARC_NAME]);
});

test("an unknown reference names it and lists the speakers and their areas", () => {
  assert.throws(
    () => resolve(["kitchen"], parse(household())),
    /No Sonos speaker or room matches "kitchen"\. Available: \[Living Room\] Sonos ARC \(Living Room\), \[Bedroom\] Sonos Playbar \(Bedroom\), \[Hobby Room\] Sonos \(Hobby Room\)/,
  );
});

test("an unavailable speaker is refused by name", () => {
  const rows = household();
  rows[1].state = "unavailable";
  assert.throws(() => resolve(["living room", "bedroom"], parse(rows)), /Sonos speaker \[Bedroom\] Sonos Playbar is unavailable/);
});

test("an empty list is refused", () => {
  assert.throws(() => resolve([], parse(household())), /Name at least one Sonos speaker or room/);
});
