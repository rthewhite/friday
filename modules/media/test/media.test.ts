import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestHost } from "@friday/sdk/test";
import { createMediaModule } from "../src/index.js";

const env = {
  JELLYFIN_URL: "http://jf.local/",
  JELLYFIN_API_KEY: "k",
  JELLYFIN_USER: "ray",
  HA_URL: "http://ha.local",
  HA_TOKEN: "t",
  HA_APPLE_TV_ENTITY: "media_player.tv",
};

type Call = { url: string; method: string; body?: string };

function fakeFetch(routes: Record<string, unknown | ((c: Call) => unknown)>, calls: Call[] = []): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const c: Call = { url, method: init?.method ?? "GET", body: init?.body as string | undefined };
    calls.push(c);
    const key = Object.keys(routes).find((k) => new URL(url).pathname === k);
    if (!key) return new Response("nope", { status: 404 });
    const v = routes[key];
    return new Response(JSON.stringify(typeof v === "function" ? (v as (c: Call) => unknown)(c) : v), { status: 200 });
  }) as typeof fetch;
}

test("manifest declares the required Jellyfin keys and the module fails without them", async () => {
  await assert.rejects(createTestHost(createMediaModule()), /module media: missing required config JELLYFIN_URL, JELLYFIN_API_KEY/);
});

test("search_library resolves the user and compacts results", async () => {
  const calls: Call[] = [];
  const f = fakeFetch(
    {
      "/Users": [{ Id: "u2", Name: "Other" }, { Id: "u1", Name: "Ray" }],
      "/Items": { Items: [{ Id: "i1", Name: "Band of Brothers", Type: "Series", ProductionYear: 2001, UserData: { UnplayedItemCount: 3 } }] },
    },
    calls,
  );
  const h = await createTestHost(createMediaModule({ fetch: f }), { env });
  assert.deepEqual(h.tools, ["search_library", "get_next_episode", "list_episodes_to_watch", "play_on_apple_tv"]);
  const r = await h.call("search_library", { query: "band", type: "series" });
  assert.deepEqual(r.result, {
    results: [{ id: "i1", type: "Series", series: undefined, season: undefined, episode: undefined, title: "Band of Brothers", year: 2001, added: undefined, minutes: undefined, watched: undefined, resume_at_minutes: undefined, unplayed_episodes: 3 }],
  });
  const items = new URL(calls[1].url);
  assert.equal(items.origin, "http://jf.local");
  assert.equal(items.searchParams.get("userId"), "u1");
  assert.equal(items.searchParams.get("includeItemTypes"), "Series");
});

test("play_on_apple_tv checks the entity, turns on, deep-links Infuse and marks played (SILENT)", async () => {
  const calls: Call[] = [];
  const f = fakeFetch(
    {
      "/Users": [{ Id: "u1", Name: "ray" }],
      "/api/states/media_player.tv": { state: "off", attributes: {} },
      "/api/services/media_player/turn_on": [],
      "/api/services/media_player/play_media": [],
      "/UserPlayedItems/ep1": {},
    },
    calls,
  );
  const h = await createTestHost(createMediaModule({ fetch: f }), { env: { ...env, JELLYFIN_PUBLIC_URL: "https://jf.example" } });
  const r = await h.call("play_on_apple_tv", { item_id: "ep1" });
  assert.deepEqual(r, { result: { started: true, marked_watched: true }, scheduling: "SILENT" });
  const play = calls.find((c) => c.url.endsWith("/play_media"))!;
  const body = JSON.parse(play.body!);
  assert.equal(body.media_content_type, "url");
  assert.match(body.media_content_id, /^infuse:\/\/x-callback-url\/play\?url=https%3A%2F%2Fjf\.example%2FVideos%2Fep1/);
});

test("play_on_apple_tv reports errors with INTERRUPT when HA is not configured or the entity is unavailable", async () => {
  const f = fakeFetch({ "/api/states/media_player.tv": { state: "unavailable", attributes: {} } });
  const noHa = await createTestHost(createMediaModule({ fetch: f }), { env: { ...env, HA_APPLE_TV_ENTITY: undefined } });
  const a = await noHa.call("play_on_apple_tv", { item_id: "x" });
  assert.equal(a.scheduling, "INTERRUPT");
  assert.match(String(a.result.error), /HA_APPLE_TV_ENTITY not configured/);

  const h = await createTestHost(createMediaModule({ fetch: f }), { env });
  const b = await h.call("play_on_apple_tv", { item_id: "x" });
  assert.match(String(b.result.error), /is unavailable in Home Assistant/);
});

test("portal routes reuse the tool implementations", async () => {
  const f = fakeFetch({
    "/Users": [{ Id: "u1", Name: "ray" }],
    "/Items": { Items: [{ Id: "m1", Name: "Heat", Type: "Movie", ProductionYear: 1995 }] },
    "/api/states/media_player.tv": { state: "off", attributes: {} },
    "/api/services/media_player/turn_on": [],
    "/api/services/media_player/play_media": [],
    "/UserPlayedItems/m1": {},
  });
  const h = await createTestHost(createMediaModule({ fetch: f }), { env });
  assert.deepEqual(h.routes, ["GET search", "POST play"]);
  assert.equal((await h.request("GET", "search")).status, 400);
  const s = await h.request("GET", "search?q=heat&type=movie");
  assert.equal(s.status, 200);
  assert.equal((s.body as any).results[0].title, "Heat");
  const p = await h.request("POST", "play", { item_id: "m1" });
  assert.deepEqual(p, { status: 200, body: { started: true, marked_watched: true }, contentType: "application/json" });
  assert.equal((await h.request("POST", "play", {})).status, 400);
  const bad = await createTestHost(createMediaModule({ fetch: f }), { env: { ...env, HA_APPLE_TV_ENTITY: undefined } });
  assert.equal((await bad.request("POST", "play", { item_id: "m1" })).status, 502);
});

test("media reads config at call time, so values saved after init are used", async () => {
  const f = fakeFetch({ "/Users": [{ Id: "u1", Name: "ray" }], "/Items": { Items: [] } });
  const live: Record<string, string | undefined> = { ...env };
  const h = await createTestHost(createMediaModule({ fetch: f }), { env: live });
  live.JELLYFIN_URL = "http://changed.local";
  const calls: Call[] = [];
  const h2 = await createTestHost(createMediaModule({ fetch: fakeFetch({ "/Users": [{ Id: "u1", Name: "ray" }], "/Items": { Items: [] } }, calls) }), { env: live });
  await h2.call("search_library", { query: "x" });
  assert.equal(new URL(calls[0].url).origin, "http://changed.local");
  void h;
});

const SERIES_ID = "0123456789abcdef0123456789abcdef";
const ep = (id: string, extra: object = {}) => ({ Id: id, Name: `Episode ${id}`, Type: "Episode", SeriesName: "Dark", ...extra });
const ids = (r: { result: Record<string, unknown> }) => (r.result.episodes as { id: string }[]).map((e) => e.id);
const episodeId = (r: { result: Record<string, unknown> }) => (r.result.episode as { id: string }).id;

test("get_next_episode resumes a partially watched episode, looked up by series id without a search", async () => {
  const calls: Call[] = [];
  const f = fakeFetch(
    { "/Users": [{ Id: "u1", Name: "ray" }], "/Shows/NextUp": { Items: [ep("e3", { UserData: { PlaybackPositionTicks: 600_000_000 * 12 } })] } },
    calls,
  );
  const h = await createTestHost(createMediaModule({ fetch: f }), { env });
  const r = await h.call("get_next_episode", { series: SERIES_ID });
  assert.deepEqual([r.result.reason, episodeId(r), (r.result.episode as { resume_at_minutes: number }).resume_at_minutes], ["resume partially watched", "e3", 12]);
  assert.ok(!calls.some((c) => new URL(c.url).pathname === "/Items"), "an id needs no search");
  assert.equal(new URL(calls.find((c) => c.url.includes("/Shows/NextUp"))!.url).searchParams.get("seriesId"), SERIES_ID);
});

test("get_next_episode falls back to the first unwatched episode, then to episode 1 when all are watched", async () => {
  const series = { "/Users": [{ Id: "u1", Name: "ray" }], "/Items": { Items: [{ Id: "s1", Name: "Dark", Type: "Series" }] }, "/Shows/NextUp": { Items: [] } };
  const watched = { UserData: { Played: true } };
  const some = await createTestHost(createMediaModule({ fetch: fakeFetch({ ...series, "/Shows/s1/Episodes": { Items: [ep("e1", watched), ep("e2"), ep("e3")] } }) }), { env });
  const a = await some.call("get_next_episode", { series: "dark" });
  assert.deepEqual([a.result.series, a.result.reason, episodeId(a)], ["Dark", "first episode", "e2"]);

  const all = await createTestHost(createMediaModule({ fetch: fakeFetch({ ...series, "/Shows/s1/Episodes": { Items: [ep("e1", watched), ep("e2", watched)] } }) }), { env });
  const b = await all.call("get_next_episode", { series: "dark" });
  assert.deepEqual([b.result.reason, episodeId(b)], ["all watched, starting over", "e1"]);
});

test("get_next_episode reports no match, a series without episodes, and other matches", async () => {
  const base = { "/Users": [{ Id: "u1", Name: "ray" }], "/Shows/NextUp": { Items: [] }, "/Shows/s1/Episodes": { Items: [] } };
  const none = await createTestHost(createMediaModule({ fetch: fakeFetch({ ...base, "/Items": { Items: [] } }) }), { env });
  assert.deepEqual((await none.call("get_next_episode", { series: "nope" })).result, { error: 'no series matching "nope"' });

  const dark = { Id: "s1", Name: "Dark", Type: "Series" };
  const empty = await createTestHost(createMediaModule({ fetch: fakeFetch({ ...base, "/Items": { Items: [dark] } }) }), { env });
  assert.deepEqual((await empty.call("get_next_episode", { series: "dark" })).result, { error: "Dark has no episodes" });

  const hits = [dark, { Id: "s2", Name: "Dark Matter", Type: "Series", ProductionYear: 2015 }, { Id: "s3", Name: "Dark Angel", Type: "Series" }];
  const several = await createTestHost(createMediaModule({ fetch: fakeFetch({ ...base, "/Items": { Items: hits } }) }), { env });
  assert.deepEqual((await several.call("get_next_episode", { series: "dark" })).result, { series: "Dark", error: "series has no episodes", other_matches: ["Dark Matter (2015)", "Dark Angel (?)"] });
});

test("list_episodes_to_watch gives next up by default and recently added on request", async () => {
  const calls: Call[] = [];
  const f = fakeFetch({ "/Users": [{ Id: "u1", Name: "ray" }], "/Shows/NextUp": { Items: [ep("n1")] }, "/Users/u1/Items/Latest": [ep("l1"), ep("l2")] }, calls);
  const h = await createTestHost(createMediaModule({ fetch: f }), { env });
  const next = await h.call("list_episodes_to_watch", {});
  assert.deepEqual([next.result.kind, ids(next)], ["next_up", ["n1"]]);
  const latest = await h.call("list_episodes_to_watch", { kind: "recently_added", limit: 2 });
  assert.deepEqual([latest.result.kind, ids(latest)], ["recently_added", ["l1", "l2"]]);
  const q = new URL(calls.find((c) => c.url.includes("/Items/Latest"))!.url).searchParams;
  assert.deepEqual([q.get("includeItemTypes"), q.get("limit")], ["Episode", "2"]);
});

test("play_on_apple_tv still reports a started stream when marking it watched fails (WHEN_IDLE)", async () => {
  const f = fakeFetch({
    "/Users": [{ Id: "u1", Name: "ray" }],
    "/api/states/media_player.tv": { state: "off", attributes: {} },
    "/api/services/media_player/turn_on": [],
    "/api/services/media_player/play_media": [],
  });
  const h = await createTestHost(createMediaModule({ fetch: f }), { env });
  const r = await h.call("play_on_apple_tv", { item_id: "ep1" });
  assert.equal(r.scheduling, "WHEN_IDLE");
  assert.deepEqual([r.result.started, r.result.marked_watched], [true, false]);
  assert.match(String(r.result.warning), /could not mark as watched: Error: jellyfin \/UserPlayedItems\/ep1 -> 404/);
});

test("an unknown Jellyfin user is an error", async () => {
  const f = fakeFetch({ "/Users": [{ Id: "u1", Name: "someone" }], "/Items": { Items: [] } });
  const h = await createTestHost(createMediaModule({ fetch: f }), { env });
  assert.match(String((await h.call("search_library", { query: "x" })).result.error), /jellyfin user ray not found/);
});
