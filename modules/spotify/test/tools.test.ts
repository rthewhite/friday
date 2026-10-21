import { test } from "node:test";
import assert from "node:assert/strict";
import { OAuthError } from "@friday/sdk";
import { createTestHost } from "@friday/sdk/test";
import { createSpotifyModule } from "../src/index.js";

const TOKEN = "BQD-t0ken";

/** A fake Spotify answering by path; records the requests. */
function fakeSpotify(routes: Record<string, unknown>) {
  const calls: { path: string; auth: string | null }[] = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    const u = new URL(String(url));
    calls.push({ path: `${u.pathname}${u.search}`, auth: new Headers(init?.headers).get("authorization") });
    const body = routes[u.pathname];
    return body === undefined ? new Response("{}", { status: 404 }) : new Response(JSON.stringify(body), { status: 200 });
  };
  return { calls, fetchImpl };
}

const radiohead = {
  tracks: { items: [{ name: "Karma Police", artists: [{ name: "Radiohead", uri: "spotify:artist:4Z8W4fKeB5YxbusRsdQVPb" }], album: { name: "OK Computer", uri: "spotify:album:6dVIqQ8qmQ5GBnJ9shOYGE" }, uri: "spotify:track:3SVAN3BRByDmHOhKyIDxfC", popularity: 80 }] },
  artists: { items: [{ name: "Radiohead", uri: "spotify:artist:4Z8W4fKeB5YxbusRsdQVPb", genres: [] }, null] },
  albums: { items: [{ name: "In Rainbows", artists: [{ name: "Radiohead" }], release_date: "2007-12-28", uri: "spotify:album:5vkqYmiPBYLaalcmjujWxK" }] },
};

test("the module loads without a token, requests spotify, and offers both tools on voice and chat", async () => {
  const h = await createTestHost(createSpotifyModule());
  assert.deepEqual(h.tools.sort(), ["list_spotify_playlists", "search_spotify"]);
  assert.deepEqual(h.toolsIn("voice").sort(), ["list_spotify_playlists", "search_spotify"]);
  assert.deepEqual(h.toolsIn("chat").sort(), ["list_spotify_playlists", "search_spotify"]);
  const m = createSpotifyModule().manifest;
  assert.deepEqual(m.oauth, [{ provider: "spotify", scopes: ["playlist-read-private", "playlist-read-collaborative"], description: "Read your private and collaborative playlists" }]);
  assert.equal(m.config, undefined);
});

test("search returns compact tracks, artists and albums with URIs", async () => {
  const s = fakeSpotify({ "/v1/search": radiohead });
  const h = await createTestHost(createSpotifyModule({ fetch: s.fetchImpl }), { oauth: { spotify: TOKEN } });
  const r = await h.call("search_spotify", { query: " Radiohead " });
  assert.deepEqual(r.result, {
    tracks: [{ name: "Karma Police", artist: "Radiohead", album: "OK Computer", uri: "spotify:track:3SVAN3BRByDmHOhKyIDxfC" }],
    artists: [{ name: "Radiohead", uri: "spotify:artist:4Z8W4fKeB5YxbusRsdQVPb" }],
    albums: [{ name: "In Rainbows", artist: "Radiohead", year: "2007", uri: "spotify:album:5vkqYmiPBYLaalcmjujWxK" }],
  });
  assert.equal(s.calls.length, 1);
  assert.equal(s.calls[0]!.path, "/v1/search?q=Radiohead&type=track%2Cartist%2Calbum&limit=10");
  assert.equal(s.calls[0]!.auth, `Bearer ${TOKEN}`);
});

test("nothing found is empty lists, not an error", async () => {
  const s = fakeSpotify({ "/v1/search": { tracks: { items: [] }, artists: { items: [] }, albums: { items: [] } } });
  const h = await createTestHost(createSpotifyModule({ fetch: s.fetchImpl }), { oauth: { spotify: TOKEN } });
  assert.deepEqual((await h.call("search_spotify", { query: "qwxzzv" })).result, { tracks: [], artists: [], albums: [] });
});

test("an empty query is refused without calling Spotify or asking for a token", async () => {
  const s = fakeSpotify({});
  const h = await createTestHost(createSpotifyModule({ fetch: s.fetchImpl }), { oauth: { spotify: TOKEN } });
  const r = await h.call("search_spotify", { query: "   " });
  assert.match(JSON.stringify(r.result), /Give something to search Spotify for/);
  assert.equal(s.calls.length, 0);
  assert.equal(h.oauthCalls.spotify, undefined);
});

test("playlists list name, description, owner, track count and URI", async () => {
  const s = fakeSpotify({
    "/v1/me/playlists": {
      items: [
        { name: "Road trip", description: "Long drives", owner: { id: "ray", display_name: "Ray" }, items: { total: 42 }, tracks: { total: 42 }, uri: "spotify:playlist:1" },
        { name: "Discover Weekly", description: "", owner: { id: "spotify", display_name: null }, tracks: { total: 30 }, uri: "spotify:playlist:2" },
        { name: "Shared", description: null, owner: { id: "sam" }, items: { total: 7 }, uri: "spotify:playlist:3" },
      ],
    },
  });
  const h = await createTestHost(createSpotifyModule({ fetch: s.fetchImpl }), { oauth: { spotify: TOKEN } });
  assert.deepEqual((await h.call("list_spotify_playlists", {})).result, {
    playlists: [
      { name: "Road trip", description: "Long drives", owner: "Ray", tracks: 42, uri: "spotify:playlist:1" },
      { name: "Discover Weekly", owner: "spotify", tracks: 30, uri: "spotify:playlist:2" },
      { name: "Shared", owner: "sam", tracks: 7, uri: "spotify:playlist:3" },
    ],
  });
  assert.equal(s.calls[0]!.path, "/v1/me/playlists?limit=50");
});

test("an OAuth rejection is passed on as the tool's error; granting later works without a reload", async () => {
  const s = fakeSpotify({ "/v1/me/playlists": { items: [] } });
  let granted = false;
  const h = await createTestHost(createSpotifyModule({ fetch: s.fetchImpl }), {
    oauth: { spotify: () => (granted ? TOKEN : new OAuthError("not_granted", "Spotify access is not granted to spotify yet. Grant it under Settings > Connections.")) },
  });
  const denied = await h.call("list_spotify_playlists", {});
  assert.match(JSON.stringify(denied.result), /Spotify access is not granted to spotify yet\. Grant it under Settings > Connections\./);
  assert.equal(s.calls.length, 0);
  granted = true;
  assert.deepEqual((await h.call("list_spotify_playlists", {})).result, { playlists: [] });
  assert.equal(h.oauthCalls.spotify, 2, "the token is asked for on every call");
});
