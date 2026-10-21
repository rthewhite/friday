import { test } from "node:test";
import assert from "node:assert/strict";
import { createSpotifyClient, SpotifyError } from "../src/spotify.js";

const TOKEN = "BQD-s3cret-token";

const respond = (status: number, body: unknown, headers: Record<string, string> = {}): typeof fetch =>
  async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

async function failure(fetchImpl: typeof fetch, timeoutMs?: number): Promise<SpotifyError> {
  const get = createSpotifyClient({ fetch: fetchImpl, ...(timeoutMs !== undefined && { timeoutMs }) });
  try {
    await get("/me/playlists", TOKEN);
  } catch (e) {
    assert.ok(e instanceof SpotifyError);
    assert.ok(!e.message.includes(TOKEN), "the token is never in a message");
    assert.ok(!e.message.includes("api.spotify.com"), "nor the request URL");
    return e;
  }
  throw new Error("expected a failure");
}

test("requests carry the bearer token and parse JSON", async () => {
  let seen: { url: string; auth: string | null } | undefined;
  const get = createSpotifyClient({ fetch: async (url, init) => { seen = { url: String(url), auth: new Headers(init?.headers).get("authorization") }; return new Response('{"items":[]}'); } });
  assert.deepEqual(await get("/me/playlists?limit=50", TOKEN), { items: [] });
  assert.deepEqual(seen, { url: "https://api.spotify.com/v1/me/playlists?limit=50", auth: `Bearer ${TOKEN}` });
});

test("401 says to reconnect Spotify", async () => {
  const e = await failure(respond(401, { error: { status: 401, message: "The access token expired" } }));
  assert.equal(e.message, "Spotify rejected the login. Reconnect Spotify under Settings > Connections.");
});

test("403 carries Spotify's message and both causes", async () => {
  const e = await failure(respond(403, { error: { status: 403, message: "Insufficient client scope" } }));
  assert.match(e.message, /^Spotify refused the request \(Insufficient client scope\)\. Either the connection lacks a permission \(reconnect Spotify under Settings > Connections\), or the Spotify app does not allow this account/);
});

test("429 names the wait from Retry-After", async () => {
  assert.equal((await failure(respond(429, {}, { "retry-after": "30" }))).message, "Spotify is rate-limiting Friday and asked to wait 30 seconds.");
  assert.equal((await failure(respond(429, {}))).message, "Spotify is rate-limiting Friday. Try again in a little while.");
});

test("other statuses, a network error and a timeout say Spotify is unavailable", async () => {
  assert.equal((await failure(respond(500, "oops"))).message, "Spotify is unavailable (HTTP 500). Try again later.");
  assert.equal((await failure(async () => { throw new TypeError("fetch failed"); })).message, "Spotify is unavailable (network error). Try again later.");
  const hang: typeof fetch = (_url, init) => new Promise((_ok, fail) => init?.signal?.addEventListener("abort", () => fail(init.signal!.reason)));
  assert.equal((await failure(hang, 20)).message, "Spotify did not answer within 0 seconds. Try again later.");
});
