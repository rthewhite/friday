import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestHost } from "@friday/sdk/test";
import { createSonosModule } from "../src/index.js";
import { play, PLAY_MEDIA_TIMEOUT_MS } from "../src/control.js";
import { parseSpeakers } from "../src/speakers.js";
import type { HaClient } from "../src/ha.js";
import { ARC, ARC_NAME, ONE_SL, ONE_SL_NAME, PLAYBAR, PLAYBAR_NAME, env, fakeHa, grouped, household, type FakeHa, type FakeHaOptions, type Row } from "./fake-ha.js";

async function host(rows: Row[] = household(), opts: FakeHaOptions = {}) {
  const ha: FakeHa = fakeHa(rows, opts);
  const h = await createTestHost(createSonosModule({ fetch: ha.fetch }), { env });
  return { ha, call: (args: Record<string, unknown>) => h.call("sonos_play", args) };
}

const playMedia = (entity: string, uri: string, enqueue: string) => ({
  service: "media_player.play_media",
  data: { entity_id: entity, media_content_id: uri, media_content_type: "music", enqueue },
});

test("one speaker: the album replaces the queue, no grouping, SILENT", async () => {
  const { ha, call } = await host();
  const r = await call({ speakers: ["Bedroom"], uris: ["spotify:album:abc"] });
  assert.deepEqual(r.result, { playing: [PLAYBAR_NAME], leader: PLAYBAR_NAME, queued: 1 });
  assert.equal(r.scheduling, "SILENT");
  assert.deepEqual(ha.calls, [playMedia(PLAYBAR, "spotify:album:abc", "replace")]);
});

test("a home theatre leads: the One SL joins the Arc and the Arc plays", async () => {
  const { ha, call } = await host();
  const r = await call({ speakers: ["Hobby Room", "Living Room"], uris: ["spotify:playlist:p"] });
  assert.equal(r.result.leader, ARC_NAME);
  assert.deepEqual(r.result.playing, [ONE_SL_NAME, ARC_NAME]);
  assert.deepEqual(ha.calls, [
    { service: "media_player.join", data: { entity_id: ARC, group_members: [ONE_SL] } },
    playMedia(ARC, "spotify:playlist:p", "replace"),
  ]);
});

test("without a home theatre the first speaker named leads", async () => {
  const rows = household();
  rows[0].model = "Era 300";
  rows[1].model = "Five";
  const { ha, call } = await host(rows);
  const r = await call({ speakers: ["Bedroom", "Living Room"], uris: ["spotify:track:t"] });
  assert.equal(r.result.leader, PLAYBAR_NAME);
  assert.deepEqual(ha.calls[0], { service: "media_player.join", data: { entity_id: PLAYBAR, group_members: [ARC] } });
});

test("a speaker in the leader's group that isn't named leaves it", async () => {
  const { ha, call } = await host(grouped(household(), ARC, PLAYBAR));
  await call({ speakers: ["Living Room", "Hobby Room"], uris: ["spotify:track:t"] });
  assert.deepEqual(ha.calls, [
    { service: "media_player.unjoin", data: { entity_id: [PLAYBAR] } },
    { service: "media_player.join", data: { entity_id: ARC, group_members: [ONE_SL] } },
    playMedia(ARC, "spotify:track:t", "replace"),
  ]);
});

test("speakers already in the leader's group are not joined again", async () => {
  const { ha, call } = await host(grouped(household(), ARC, ONE_SL));
  await call({ speakers: ["Living Room", "Hobby Room"], uris: ["spotify:track:t"] });
  assert.deepEqual(ha.calls, [playMedia(ARC, "spotify:track:t", "replace")]);
});

test("a leader that is a member of another group leaves it first", async () => {
  const { ha, call } = await host(grouped(household(), ONE_SL, ARC, PLAYBAR));
  await call({ speakers: ["Living Room", "Bedroom"], uris: ["spotify:track:t"] });
  assert.deepEqual(ha.calls, [
    { service: "media_player.unjoin", data: { entity_id: [ARC] } },
    { service: "media_player.join", data: { entity_id: ARC, group_members: [PLAYBAR] } },
    playMedia(ARC, "spotify:track:t", "replace"),
  ]);
});

test("a grouped speaker named alone leaves its group and plays alone", async () => {
  const { ha, call } = await host(grouped(household(), ARC, ONE_SL));
  const r = await call({ speakers: ["Hobby Room"], uris: ["spotify:track:t"] });
  assert.equal(r.result.leader, ONE_SL_NAME);
  assert.deepEqual(ha.calls, [{ service: "media_player.unjoin", data: { entity_id: [ONE_SL] } }, playMedia(ONE_SL, "spotify:track:t", "replace")]);
});

test("several URIs: the first replaces the queue, the rest are added in order", async () => {
  const { ha, call } = await host();
  const r = await call({ speakers: ["Living Room"], uris: ["spotify:track:a", "spotify:track:b", "spotify:track:c"] });
  assert.equal(r.result.queued, 3);
  assert.deepEqual(ha.calls, [playMedia(ARC, "spotify:track:a", "replace"), playMedia(ARC, "spotify:track:b", "add"), playMedia(ARC, "spotify:track:c", "add")]);
});

test("a share link is passed to Home Assistant as given", async () => {
  const { ha, call } = await host();
  await call({ speakers: ["Living Room"], uris: ["https://open.spotify.com/intl-nl/playlist/xyz?si=123"] });
  assert.deepEqual(ha.calls, [playMedia(ARC, "https://open.spotify.com/intl-nl/playlist/xyz?si=123", "replace")]);
});

test("an artist URI fails before Home Assistant is asked anything", async () => {
  const { ha, call } = await host();
  const r = await call({ speakers: ["Living Room"], uris: ["spotify:artist:abc"] });
  assert.match(String(r.result.error), /artist.*Play the artist's tracks, an album or a playlist instead/);
  assert.equal(r.scheduling, "INTERRUPT");
  assert.equal(ha.requests.length, 0);
});

test("a URI that isn't Spotify fails naming it, with no service call", async () => {
  const { ha, call } = await host();
  const r = await call({ speakers: ["Living Room"], uris: ["https://example.com/song.mp3"] });
  assert.match(String(r.result.error), /"https:\/\/example\.com\/song\.mp3" is not a Spotify/);
  assert.equal(ha.calls.length, 0);
});

test("an unknown speaker fails with no service call", async () => {
  const { ha, call } = await host();
  const r = await call({ speakers: ["Kitchen"], uris: ["spotify:track:t"] });
  assert.match(String(r.result.error), /No Sonos speaker or room matches "Kitchen"/);
  assert.equal(ha.calls.length, 0);
});

test("a later URI that fails to be added is reported, WHEN_IDLE", async () => {
  const { call } = await host(household(), { fail: (c) => (c.data.media_content_id === "spotify:track:b" ? 500 : undefined) });
  const r = await call({ speakers: ["Living Room"], uris: ["spotify:track:a", "spotify:track:b", "spotify:track:c"] });
  assert.equal(r.result.queued, 2);
  // The warning says why, so a bad URI can be told apart from a Home Assistant failure.
  assert.match(String(r.result.warning), /spotify:track:b \(home assistant media_player\.play_media -> 500 service failed\)/);
  assert.doesNotMatch(String(r.result.warning), /spotify:track:c/);
  assert.equal(r.scheduling, "WHEN_IDLE");
});

test("play_media waits longer than other requests, for share links HA takes up to 30 s to queue", async () => {
  const timeouts: Record<string, number | undefined> = {};
  const ha: HaClient = {
    template: async () => "[]",
    call: async (domain, service, _data, timeoutMs) => void (timeouts[`${domain}.${service}`] = timeoutMs),
  };
  const all = parseSpeakers(JSON.stringify(household()));
  await play(ha, all.slice(0, 2), ["spotify:playlist:p", "spotify:track:t"]);
  assert.equal(timeouts["media_player.play_media"], PLAY_MEDIA_TIMEOUT_MS);
  assert.ok(PLAY_MEDIA_TIMEOUT_MS > 30_000);
  assert.equal(timeouts["media_player.join"], undefined);
});

test("a failing first URI fails the call", async () => {
  const { call } = await host(household(), { fail: (c) => (c.service === "media_player.play_media" ? 500 : undefined) });
  const r = await call({ speakers: ["Living Room"], uris: ["spotify:track:a"] });
  assert.match(String(r.result.error), /media_player\.play_media -> 500/);
});

test("a failing join starts no playback and names the service", async () => {
  const { ha, call } = await host(household(), { fail: (c) => (c.service === "media_player.join" ? 500 : undefined) });
  const r = await call({ speakers: ["Living Room", "Hobby Room"], uris: ["spotify:track:a"] });
  assert.match(String(r.result.error), /media_player\.join -> 500/);
  assert.doesNotMatch(String(r.result.error), /ha-secret-token/);
  assert.ok(!ha.calls.some((c) => c.service === "media_player.play_media"));
});
