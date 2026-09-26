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
