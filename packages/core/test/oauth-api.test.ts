import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import * as arctic from "arctic";
import { defineModule, ToolRegistry } from "@friday/sdk";
import { createApp } from "../src/app.js";
import { ModuleHost } from "../src/module-host.js";
import { McpSource } from "../src/tools/mcp.js";
import { McpServerStore } from "../src/tools/mcp-store.js";
import { migrate, migrations } from "../src/storage/db.js";
import { OAuthStore } from "../src/oauth/store.js";
import { enabledManifests, OAuthRequests } from "../src/oauth/requests.js";
import { OAuthFlow, STATE_TTL_MS } from "../src/oauth/flow.js";
import type { BuildClient } from "../src/oauth/catalogue.js";

const quiet = { log() {}, warn() {}, error() {} };
const SECRET = "client-s3cret";

const spotifyModule = defineModule({ manifest: { id: "spotify", label: "Spotify", oauth: [{ provider: "spotify", scopes: ["playlist-read-private"], description: "Read your playlists" }] }, init() {} });
const sonos = defineModule({ manifest: { id: "sonos", label: "Sonos", oauth: [{ provider: "spotify", scopes: ["user-modify-playback-state"] }] }, init() {} });
const acmeSync = defineModule({ manifest: { id: "acme-sync", label: "Acme", oauth: [{ provider: "acme", scopes: ["read"], authUrl: "https://acme.example/authorize", tokenUrl: "https://acme.example/token" }] }, init() {} });
const travel = defineModule({ manifest: { id: "travel", label: "Travel" }, init() {} });

interface Opts {
  masterKey?: Buffer | null;
  publicUrl?: string | (() => string | undefined);
  exchange?: () => Promise<arctic.OAuth2Tokens>;
  /** Whether the fake client uses PKCE (default true). */
  pkce?: boolean;
}

async function start(o: Opts = {}) {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db, migrations, quiet);
  const store = new OAuthStore(db, o.masterKey === null ? undefined : (o.masterKey ?? randomBytes(32)), quiet);
  const registry = new ToolRegistry(quiet);
  const host = new ModuleHost(registry, { env: {}, log: quiet });
  await host.load([spotifyModule, sonos, acmeSync, travel]);
  const requests = new OAuthRequests(() => enabledManifests(host));
  const exchanges: { code: string; verifier: string | undefined; scopes: string[]; redirectUri: string }[] = [];
  let now = Date.now();
  const buildClient: BuildClient = (cfg, redirectUri) => ({
    pkce: o.pkce ?? true,
    refresh: true,
    authorizationUrl(state, verifier, scopes) {
      const u = new URL(cfg.authUrl ?? "https://accounts.example/authorize");
      u.searchParams.set("client_id", cfg.clientId);
      u.searchParams.set("redirect_uri", redirectUri);
      u.searchParams.set("scope", scopes.join(" "));
      u.searchParams.set("state", state);
      if (verifier) u.searchParams.set("code_challenge", "challenge");
      return u;
    },
    async exchange(code, verifier, scopes) {
      exchanges.push({ code, verifier, scopes, redirectUri });
      return o.exchange ? o.exchange() : new arctic.OAuth2Tokens({ access_token: "AT-1", refresh_token: "RT-1", expires_in: 3600, scope: "playlist-read-private" });
    },
    refreshToken: async () => { throw new Error("not used"); },
  });
  const flow = new OAuthFlow({ store, requests, buildClient, now: () => now });
  const mcp = new McpSource(registry, new McpServerStore(db, undefined), { log: quiet });
  const server = createServer(createApp({ registry, host, mcp, webDir: "/nonexistent", oauth: { store, requests, flow, publicUrl: typeof o.publicUrl === "function" ? o.publicUrl : () => o.publicUrl as string | undefined } }));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const bodies: string[] = [];
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(base + path, { method, redirect: "manual", headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    bodies.push(text);
    return { status: res.status, json: text && res.headers.get("content-type")?.includes("json") ? JSON.parse(text) : undefined, headers: res.headers };
  };
  const raw = (method: string, path: string, headers: Record<string, string>) =>
    new Promise<number>((ok, fail) => {
      const req = request(base + path, { method, headers }, (res) => { res.resume(); res.on("end", () => ok(res.statusCode!)); });
      req.on("error", fail);
      req.end();
    });
  const listing = async (headers: Record<string, string> = {}) => (await call("GET", "/api/oauth/connections", undefined, headers)).json;
  const entry = async (provider: string, headers: Record<string, string> = {}) => (await listing(headers)).connections.find((c: { provider: string }) => c.provider === provider);
  /** Start a login; returns the provider URL and the state cookie the browser would hold. */
  const authorize = async (provider = "spotify", headers: Record<string, string> = {}) => {
    const r = await call("GET", `/api/oauth/${provider}/authorize`, undefined, headers);
    const setCookie = r.headers.getSetCookie()[0] ?? "";
    return { status: r.status, location: r.headers.get("location") ? new URL(r.headers.get("location")!) : undefined, setCookie, cookie: setCookie.split(";")[0]!, json: r.json };
  };
  const callback = async (provider: string, query: Record<string, string>, cookie?: string) => {
    const r = await call("GET", `/api/oauth/${provider}/callback?${new URLSearchParams(query)}`, undefined, cookie ? { cookie } : {});
    const location = new URL(r.headers.get("location")!, base);
    return { status: r.status, location, setCookie: r.headers.getSetCookie()[0] ?? "" };
  };
  const setUp = async () => {
    assert.equal((await call("PUT", "/api/oauth/connections/spotify", { clientId: "client-1", clientSecret: SECRET })).status, 200);
    assert.equal((await call("PUT", "/api/oauth/connections/spotify/grants/spotify")).status, 204);
  };
  return { base, store, exchanges, call, raw, listing, entry, authorize, callback, setUp, bodies, advance: (ms: number) => { now += ms; }, close: () => { server.close(); } };
}

test("authorize redirects to the provider with the grants' scopes and sets the state cookie", async () => {
  const s = await start();
  try {
    await s.setUp();
    const a = await s.authorize();
    assert.equal(a.status, 302);
    assert.equal(a.location!.origin, "https://accounts.example");
    assert.equal(a.location!.searchParams.get("scope"), "playlist-read-private", "sonos is not granted, so its scope is not asked for");
    assert.equal(a.location!.searchParams.get("client_id"), "client-1");
    assert.equal(a.location!.searchParams.get("code_challenge"), "challenge");
    const state = a.location!.searchParams.get("state")!;
    assert.ok(state.length >= 20);
    assert.equal(a.setCookie, `friday_oauth_state=${state}; HttpOnly; SameSite=Lax; Path=/api/oauth; Max-Age=${STATE_TTL_MS / 1000}`);
  } finally {
    s.close();
  }
});

test("a valid callback stores the tokens and granted scopes and returns to the portal", async () => {
  const s = await start();
  try {
    await s.setUp();
    const a = await s.authorize();
    const state = a.location!.searchParams.get("state")!;
    const cb = await s.callback("spotify", { code: "the-code", state }, a.cookie);
    assert.equal(cb.status, 302);
    assert.equal(`${cb.location.pathname}${cb.location.search}`, "/settings/connections?provider=spotify&connected=1");
    assert.match(cb.setCookie, /^friday_oauth_state=; .*Max-Age=0/);
    assert.equal(s.exchanges.length, 1);
    assert.equal(s.exchanges[0]!.code, "the-code");
    assert.ok(s.exchanges[0]!.verifier, "the verifier from authorize is used");
    assert.equal(s.exchanges[0]!.redirectUri, a.location!.searchParams.get("redirect_uri"), "the same redirect URI as authorize");
    const e = await s.entry("spotify");
    assert.equal(e.state, "connected");
    assert.deepEqual(e.grantedScopes, ["playlist-read-private"]);
    assert.ok(Date.parse(e.expiresAt) > Date.now());
    assert.deepEqual(s.store.secrets("spotify"), { clientSecret: SECRET, accessToken: "AT-1", refreshToken: "RT-1" });
  } finally {
    s.close();
  }
});

test("a mismatched, missing, reused, expired or other-provider state is refused without calling the provider", async () => {
  const s = await start();
  try {
    await s.setUp();
    await s.call("PUT", "/api/oauth/connections/acme", { clientId: "a", authUrl: "https://acme.example/authorize", tokenUrl: "https://acme.example/token" });
    const refused = async (provider: string, query: Record<string, string>, cookie?: string) => {
      const cb = await s.callback(provider, query, cookie);
      assert.equal(cb.location.pathname, "/settings/connections");
      assert.equal(cb.location.searchParams.get("provider"), provider);
      assert.match(cb.location.searchParams.get("error")!, /could not be verified|expired/);
      return cb;
    };
    const a = await s.authorize();
    const state = a.location!.searchParams.get("state")!;
    await refused("spotify", { code: "c", state }, "friday_oauth_state=someone-elses");
    // That attempt used the state up; a fresh login for the rest.
    const b = await s.authorize();
    await refused("spotify", { code: "c" }, b.cookie);
    const c = await s.authorize();
    const stateC = c.location!.searchParams.get("state")!;
    await refused("acme", { code: "c", state: stateC }, c.cookie);
    const d = await s.authorize();
    const stateD = d.location!.searchParams.get("state")!;
    assert.equal((await s.callback("spotify", { code: "c", state: stateD }, d.cookie)).location.searchParams.get("connected"), "1");
    await refused("spotify", { code: "c", state: stateD }, d.cookie);
    const e = await s.authorize();
    s.advance(STATE_TTL_MS + 1);
    const expired = await refused("spotify", { code: "c", state: e.location!.searchParams.get("state")! }, e.cookie);
    assert.match(expired.location.searchParams.get("error")!, /expired/);
    assert.equal(s.exchanges.length, 1, "only the valid callback reached the provider");
  } finally {
    s.close();
  }
});

test("the user declining keeps the stored tokens; a failed exchange sets error", async () => {
  const s = await start({ exchange: async () => { throw new arctic.OAuth2RequestError("invalid_grant", "Invalid authorization code", null, null); } });
  try {
    await s.setUp();
    s.store.storeTokens("spotify", { accessToken: "AT-0", refreshToken: "RT-0", expiresAt: new Date(Date.now() + 3600_000) });
    const a = await s.authorize();
    const declined = await s.callback("spotify", { error: "access_denied", state: a.location!.searchParams.get("state")! }, a.cookie);
    assert.equal(declined.location.searchParams.get("error"), "Spotify did not connect: access_denied");
    assert.equal((await s.entry("spotify")).state, "connected");
    assert.equal(s.store.secrets("spotify").accessToken, "AT-0");

    const b = await s.authorize();
    const failedReconnect = await s.callback("spotify", { code: "bad", state: b.location!.searchParams.get("state")! }, b.cookie);
    assert.match(failedReconnect.location.searchParams.get("error")!, /refused: invalid_grant: Invalid authorization code/);
    assert.equal((await s.entry("spotify")).state, "connected", "a failed Reconnect leaves a working login as it was");
    assert.equal(s.store.secrets("spotify").accessToken, "AT-0");

    // Without a working login, the failure shows on the connection.
    await s.call("PUT", "/api/oauth/connections/spotify", { clientId: "client-2", clientSecret: SECRET });
    const c = await s.authorize();
    await s.callback("spotify", { code: "bad", state: c.location!.searchParams.get("state")! }, c.cookie);
    const e = await s.entry("spotify");
    assert.equal(e.state, "error");
    assert.match(e.error, /invalid_grant: Invalid authorization code/);
  } finally {
    s.close();
  }
});

test("an unreadable token does not block the Reconnect that replaces it; a client changed mid-login refuses the callback", async () => {
  const s = await start();
  try {
    await s.setUp();
    s.store.storeTokens("spotify", { accessToken: "AT-0", refreshToken: "RT-0", expiresAt: new Date(Date.now() + 3600_000) });
    const db = (s.store as unknown as { db: DatabaseSync }).db;
    db.prepare("UPDATE oauth_connections SET access_token_tag = ? WHERE provider = 'spotify'").run(randomBytes(16));
    const a = await s.authorize();
    assert.equal(a.status, 302, "authorize reads only the client secret");
    const cb = await s.callback("spotify", { code: "c", state: a.location!.searchParams.get("state")! }, a.cookie);
    assert.equal(cb.location.searchParams.get("connected"), "1");
    assert.equal(s.store.secrets("spotify").accessToken, "AT-1", "the new login replaced the unreadable token");

    const b = await s.authorize();
    await s.call("PUT", "/api/oauth/connections/spotify", { clientId: "client-2" });
    const changed = await s.callback("spotify", { code: "c", state: b.location!.searchParams.get("state")! }, b.cookie);
    assert.match(changed.location.searchParams.get("error")!, /changed during the login/);
    assert.equal(s.exchanges.length, 1, "the old client's code was not exchanged");
  } finally {
    s.close();
  }
});

/** Make the stored client secret undecryptable, as a wrong or rotated master key would. */
const breakClientSecret = (store: unknown) =>
  (store as { db: DatabaseSync }).db.prepare("UPDATE oauth_connections SET client_secret_tag = ? WHERE provider = 'spotify'").run(randomBytes(16));

test("authorize answers 409 when the stored client secret cannot be decrypted", async () => {
  const s = await start();
  try {
    await s.setUp();
    breakClientSecret(s.store);
    const a = await s.authorize();
    assert.equal(a.status, 409);
    assert.equal(a.setCookie, "", "no login is started");
  } finally {
    s.close();
  }
});

test("a client without PKCE sends no code challenge and exchanges without a verifier", async () => {
  const s = await start({ pkce: false });
  try {
    await s.setUp();
    const a = await s.authorize();
    assert.equal(a.location!.searchParams.get("code_challenge"), null);
    const cb = await s.callback("spotify", { code: "c", state: a.location!.searchParams.get("state")! }, a.cookie);
    assert.equal(cb.location.searchParams.get("connected"), "1");
    assert.equal(s.exchanges[0]!.verifier, undefined);
  } finally {
    s.close();
  }
});

test("a callback without a code, for a deleted connection, or with an unreadable client secret is refused without exchanging", async () => {
  const s = await start();
  try {
    await s.setUp();
    const a = await s.authorize();
    const noCode = await s.callback("spotify", { state: a.location!.searchParams.get("state")! }, a.cookie);
    assert.equal(noCode.location.searchParams.get("error"), "Spotify sent no authorization code. Click Connect again.");

    const b = await s.authorize();
    assert.equal((await s.call("DELETE", "/api/oauth/connections/spotify")).status, 204);
    const deleted = await s.callback("spotify", { code: "c", state: b.location!.searchParams.get("state")! }, b.cookie);
    assert.equal(deleted.location.searchParams.get("error"), "The Spotify connection was deleted during the login.");

    await s.setUp();
    const c = await s.authorize();
    breakClientSecret(s.store);
    const unreadable = await s.callback("spotify", { code: "c", state: c.location!.searchParams.get("state")! }, c.cookie);
    assert.ok(unreadable.location.searchParams.get("error"), "the decrypt failure is reported");
    assert.equal(unreadable.location.searchParams.get("connected"), null);
    assert.equal(s.exchanges.length, 0);
  } finally {
    s.close();
  }
});

test("a provider error carries its description", async () => {
  const s = await start();
  try {
    await s.setUp();
    const a = await s.authorize();
    const cb = await s.callback("spotify", { error: "access_denied", error_description: "The user said no", state: a.location!.searchParams.get("state")! }, a.cookie);
    assert.equal(cb.location.searchParams.get("error"), "Spotify did not connect: access_denied: The user said no");
  } finally {
    s.close();
  }
});

test("an exchange that fails on the network or with an unexpected HTTP status says which on the connection", async () => {
  for (const [failure, expected] of [
    [new TypeError("fetch failed"), "exchanging the authorization code failed: network error"],
    [new arctic.UnexpectedResponseError(502), "exchanging the authorization code failed: HTTP 502"],
    [new arctic.UnexpectedErrorResponseBodyError(500, "oops"), "exchanging the authorization code failed: HTTP 500"],
  ] as const) {
    const s = await start({ exchange: async () => { throw failure; } });
    try {
      await s.setUp();
      const a = await s.authorize();
      const cb = await s.callback("spotify", { code: "c", state: a.location!.searchParams.get("state")! }, a.cookie);
      assert.equal(cb.location.searchParams.get("error"), `Spotify: ${expected}`);
      const e = await s.entry("spotify");
      assert.deepEqual([e.state, e.error], ["error", expected]);
    } finally {
      s.close();
    }
  }
});

test("tokens from an exchange during which the connection got another client are discarded", async () => {
  const during: { fn?: () => Promise<unknown> } = {};
  const s = await start({ exchange: async () => (await during.fn?.(), new arctic.OAuth2Tokens({ access_token: "AT-1", expires_in: 3600 })) });
  try {
    await s.setUp();
    const a = await s.authorize();
    during.fn = () => s.call("PUT", "/api/oauth/connections/spotify", { clientId: "client-2" });
    const cb = await s.callback("spotify", { code: "c", state: a.location!.searchParams.get("state")! }, a.cookie);
    assert.match(cb.location.searchParams.get("error")!, /changed during the login/);
    assert.equal(s.store.hasTokens("spotify"), false, "the tokens belong to nobody and are not stored");
  } finally {
    s.close();
  }
});

test("an expired login is swept when the next one starts, so its state no longer verifies", async () => {
  const s = await start();
  try {
    await s.setUp();
    const a = await s.authorize();
    s.advance(STATE_TTL_MS + 1);
    await s.authorize();
    const cb = await s.callback("spotify", { code: "c", state: a.location!.searchParams.get("state")! }, a.cookie);
    assert.match(cb.location.searchParams.get("error")!, /could not be verified/);
  } finally {
    s.close();
  }
});

test("tokens that report no scopes record the scopes that were asked for", async () => {
  const s = await start({ exchange: async () => new arctic.OAuth2Tokens({ access_token: "AT-1", expires_in: 3600 }) });
  try {
    await s.setUp();
    const a = await s.authorize();
    await s.callback("spotify", { code: "c", state: a.location!.searchParams.get("state")! }, a.cookie);
    assert.deepEqual((await s.entry("spotify")).grantedScopes, ["playlist-read-private"]);
  } finally {
    s.close();
  }
});

test("start passes on a store failure that is not a decrypt error", () => {
  const failure = new Error("database is locked");
  const store = { get: () => ({ provider: "spotify", clientId: "c" }), secretsEnabled: true, clientSecret: () => { throw failure; } };
  const flow = new OAuthFlow({ store: store as unknown as OAuthStore, requests: {} as OAuthRequests });
  assert.throws(() => flow.start("spotify", "http://localhost"), (e) => e === failure);
});

test("authorize answers 404 without a connection and 503 without a master key", async () => {
  const s = await start();
  try {
    assert.equal((await s.authorize()).status, 404);
  } finally {
    s.close();
  }
  const noKey = await start({ masterKey: null });
  try {
    const db = (noKey.store as unknown as { db: DatabaseSync }).db;
    db.prepare("INSERT INTO oauth_connections (provider, client_id, created_at, updated_at) VALUES ('spotify', 'id', 't', 't')").run();
    const a = await noKey.authorize();
    assert.equal(a.status, 503);
    assert.match(a.json.error, /FRIDAY_MASTER_KEY/);
    const put = await noKey.call("PUT", "/api/oauth/connections/spotify", { clientId: "id", clientSecret: "s" });
    assert.equal(put.status, 503);
    assert.equal((await noKey.listing()).secretsEnabled, false);
  } finally {
    noKey.close();
  }
});

test("the redirect URI comes from FRIDAY_PUBLIC_URL, else the forwarded origin, else the request's origin", async () => {
  const pub = await start({ publicUrl: "https://friday.thewhite.nl/" });
  try {
    await pub.setUp();
    assert.equal((await pub.entry("spotify")).redirectUri, "https://friday.thewhite.nl/api/oauth/spotify/callback");
    assert.equal((await pub.listing()).redirectBase, "https://friday.thewhite.nl");
    // Opened at another address: authorize first moves to the public base, so the cookie lands where the callback does.
    const moved = await pub.authorize();
    assert.equal(moved.status, 302);
    assert.equal(moved.location!.toString(), "https://friday.thewhite.nl/api/oauth/spotify/authorize?moved=1");
    assert.equal(moved.setCookie, "", "no state is issued on the wrong host");
    const a = await pub.authorize("spotify", { "x-forwarded-proto": "https", "x-forwarded-host": "friday.thewhite.nl" });
    assert.equal(a.location!.searchParams.get("redirect_uri"), "https://friday.thewhite.nl/api/oauth/spotify/callback");
    assert.match(a.setCookie, /; Secure$/, "the cookie is Secure on https");
    // Behind a proxy that hides the public host, the marker stops a redirect loop.
    const marked = await pub.call("GET", "/api/oauth/spotify/authorize?moved=1");
    assert.equal(new URL(marked.headers.get("location")!).origin, "https://accounts.example");
  } finally {
    pub.close();
  }
  const invalid = await start({ publicUrl: "friday.thewhite.nl" });
  try {
    await invalid.setUp();
    assert.equal((await invalid.entry("spotify")).redirectUri, `${invalid.base}/api/oauth/spotify/callback`, "a public URL without a scheme is ignored");
  } finally {
    invalid.close();
  }
  const s = await start();
  try {
    await s.setUp();
    const forwarded = await s.entry("spotify", { "x-forwarded-proto": "https", "x-forwarded-host": "friday.thewhite.nl" });
    assert.equal(forwarded.redirectUri, "https://friday.thewhite.nl/api/oauth/spotify/callback");
    assert.equal((await s.entry("spotify")).redirectUri, `${s.base}/api/oauth/spotify/callback`);
    assert.match(s.base, /^http:\/\/127\.0\.0\.1:\d+$/);
  } finally {
    s.close();
  }
});

test("a public URL saved later applies to the next listing and authorization without a restart", async () => {
  let saved: string | undefined;
  const s = await start({ publicUrl: () => saved });
  try {
    await s.setUp();
    assert.equal((await s.entry("spotify")).redirectUri, `${s.base}/api/oauth/spotify/callback`);
    saved = "https://friday.thewhite.nl";
    assert.equal((await s.entry("spotify")).redirectUri, "https://friday.thewhite.nl/api/oauth/spotify/callback");
    const a = await s.authorize("spotify", { "x-forwarded-proto": "https", "x-forwarded-host": "friday.thewhite.nl" });
    assert.equal(a.location!.searchParams.get("redirect_uri"), "https://friday.thewhite.nl/api/oauth/spotify/callback");
  } finally {
    s.close();
  }
});

test("the listing has every field, entries for requests without a connection, and never a secret or token", async () => {
  const s = await start();
  try {
    let list = await s.listing();
    assert.equal(list.secretsEnabled, true);
    assert.deepEqual(list.connections.map((c: { provider: string }) => c.provider), ["acme", "spotify"]);
    const unset = list.connections.find((c: { provider: string }) => c.provider === "spotify");
    assert.deepEqual(unset, {
      provider: "spotify", name: "Spotify", configured: false, generic: false, hasClientSecret: false, extraScopes: [],
      requestedScopes: [], missingScopes: [],
      requesters: [
        { module: "spotify", scopes: ["playlist-read-private"], description: "Read your playlists", granted: false },
        { module: "sonos", scopes: ["user-modify-playback-state"], granted: false },
      ],
      redirectUri: `${s.base}/api/oauth/spotify/callback`,
    });
    const acme = list.connections.find((c: { provider: string }) => c.provider === "acme");
    assert.equal(acme.generic, true);
    assert.equal(acme.authUrl, "https://acme.example/authorize", "generic defaults from the request");
    assert.equal(acme.tokenUrl, "https://acme.example/token");

    await s.setUp();
    const a = await s.authorize();
    await s.callback("spotify", { code: "c", state: a.location!.searchParams.get("state")! }, a.cookie);
    await s.call("PUT", "/api/oauth/connections/spotify", { clientId: "client-1", extraScopes: ["user-read-email"] });
    await s.call("PUT", "/api/oauth/connections/spotify/grants/sonos");
    list = await s.listing();
    const e = list.connections.find((c: { provider: string }) => c.provider === "spotify");
    assert.equal(e.configured, true);
    assert.equal(e.clientId, "client-1");
    assert.equal(e.hasClientSecret, true);
    assert.equal(e.state, "connected");
    assert.deepEqual(e.requestedScopes, ["playlist-read-private", "user-modify-playback-state", "user-read-email"]);
    assert.deepEqual(e.missingScopes, [{ scope: "user-modify-playback-state", modules: ["sonos"] }, { scope: "user-read-email", modules: [] }]);
    assert.deepEqual(e.requesters.map((r: { granted: boolean }) => r.granted), [true, true]);
    for (const k of ["expiresAt", "updatedAt", "grantedScopes", "redirectUri"]) assert.ok(k in e, k);
    for (const body of s.bodies) for (const secret of [SECRET, "AT-1", "RT-1"]) assert.ok(!body.includes(secret), `${secret} left core`);
  } finally {
    s.close();
  }
});

test("writes validate their input, upsert, delete and refuse grants to non-requesters", async () => {
  const s = await start();
  try {
    assert.equal((await s.call("PUT", "/api/oauth/connections/acme", { clientId: "a" })).status, 400);
    assert.match((await s.call("PUT", "/api/oauth/connections/acme", { clientId: "a", authUrl: "https://acme.example/a", tokenUrl: "http://acme.example/t" })).json.error, /https/);
    assert.equal((await s.call("PUT", "/api/oauth/connections/Spotify", { clientId: "a" })).status, 400);
    assert.equal((await s.call("PUT", "/api/oauth/connections/connections", { clientId: "a" })).status, 400);
    assert.equal((await s.call("PUT", "/api/oauth/connections/spotify/grants/spotify")).status, 404, "no connection yet");

    const created = await s.call("PUT", "/api/oauth/connections/spotify", { clientId: "client-1", clientSecret: SECRET });
    assert.equal(created.status, 200);
    assert.equal(created.json.state, "disconnected");
    const updated = await s.call("PUT", "/api/oauth/connections/spotify", { clientId: "client-2" });
    assert.equal(updated.status, 200, "the same PUT updates");
    assert.equal(updated.json.clientId, "client-2");
    assert.equal(updated.json.hasClientSecret, true, "leaving the secret out keeps it");

    assert.equal((await s.call("PUT", "/api/oauth/connections/spotify/grants/travel")).status, 404, "travel does not request spotify");
    assert.equal((await s.call("PUT", "/api/oauth/connections/spotify/grants/spotify")).status, 204);
    assert.equal((await s.call("DELETE", "/api/oauth/connections/spotify/grants/spotify")).status, 204);
    assert.equal((await s.entry("spotify")).requesters[0].granted, false);

    assert.equal((await s.call("DELETE", "/api/oauth/connections/spotify")).status, 204);
    assert.equal((await s.call("DELETE", "/api/oauth/connections/spotify")).status, 404);
    assert.equal((await s.entry("spotify")).configured, false);
  } finally {
    s.close();
  }
});

test("cross-site writes are refused by the CSRF guard; authorize and callback are GET and unaffected", async () => {
  const s = await start();
  try {
    assert.equal(await s.raw("PUT", "/api/oauth/connections/spotify", { "sec-fetch-site": "cross-site", "content-type": "application/json" }), 403);
    assert.equal(await s.raw("DELETE", "/api/oauth/connections/spotify", { "sec-fetch-site": "cross-site" }), 403);
    assert.equal(await s.raw("PUT", "/api/oauth/connections/spotify/grants/spotify", { "sec-fetch-site": "cross-site" }), 403);
    assert.equal(await s.raw("GET", "/api/oauth/spotify/callback?state=x", { "sec-fetch-site": "cross-site" }), 302);
  } finally {
    s.close();
  }
});

test("the provider catalogue is listed", async () => {
  const s = await start();
  try {
    const providers = (await s.call("GET", "/api/oauth/providers")).json;
    assert.deepEqual(providers.find((p: { id: string }) => p.id === "spotify"), { id: "spotify", name: "Spotify", pkce: true, refresh: true });
    assert.equal(providers.at(-1).id, "generic");
  } finally {
    s.close();
  }
});
