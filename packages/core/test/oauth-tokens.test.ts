import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import * as arctic from "arctic";
import { OAuthError, type ModuleManifest } from "@friday/sdk";
import { migrate, migrations } from "../src/storage/db.js";
import { OAuthStore } from "../src/oauth/store.js";
import { OAuthRequests } from "../src/oauth/requests.js";
import { OAuthTokens } from "../src/oauth/tokens.js";
import type { BuildClient, OAuthClient } from "../src/oauth/catalogue.js";

const T0 = Date.parse("2026-10-21T12:00:00Z");
const quiet = { log() {}, error() {} };
const manifests: ModuleManifest[] = [
  { id: "spotify", label: "Spotify", oauth: [{ provider: "spotify", scopes: ["playlist-read-private"] }] },
  { id: "sonos", label: "Sonos", oauth: [{ provider: "spotify", scopes: [] }] },
  { id: "travel", label: "Travel" },
];

interface Setup {
  refresh?: (rt: string, scopes: string[]) => Promise<arctic.OAuth2Tokens>;
  canRefresh?: boolean;
  masterKey?: Buffer | undefined;
}

function setup(o: Setup = {}) {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db, migrations, quiet);
  let now = T0;
  const key = "masterKey" in o ? o.masterKey : randomBytes(32);
  const store = new OAuthStore(db, key ?? randomBytes(32), quiet, () => new Date(now));
  const refreshes: { rt: string; scopes: string[] }[] = [];
  const client: OAuthClient = {
    pkce: true,
    refresh: o.canRefresh ?? true,
    authorizationUrl: () => new URL("https://accounts.example/authorize"),
    exchange: async () => { throw new Error("not used"); },
    refreshToken: async (rt, scopes) => {
      refreshes.push({ rt, scopes });
      return o.refresh ? o.refresh(rt, scopes) : new arctic.OAuth2Tokens({ access_token: "AT-2", expires_in: 3600, token_type: "Bearer" });
    },
  };
  const buildClient: BuildClient = () => client;
  const warnings: string[] = [];
  const tokens = new OAuthTokens({
    store: key === undefined ? new OAuthStore(db, undefined, quiet) : store,
    requests: new OAuthRequests(() => manifests),
    redirectUri: (p) => `https://friday.example/api/oauth/${p}/callback`,
    buildClient,
    now: () => now,
    log: { warn: (m: string) => warnings.push(m) },
  });
  const connect = (expiresInMs: number | undefined, refreshToken: string | undefined = "RT-1") => {
    store.upsert({ provider: "spotify", clientId: "id", clientSecret: "s" });
    store.storeTokens("spotify", { accessToken: "AT-1", ...(refreshToken && { refreshToken }), ...(expiresInMs !== undefined && { expiresAt: new Date(now + expiresInMs) }), grantedScopes: ["playlist-read-private"] });
    store.grant("spotify", "spotify");
  };
  return { db, store, tokens, refreshes, warnings, connect, setNow: (t: number) => { now = t; } };
}

const rejects = async (p: Promise<unknown>, kind: string, re: RegExp) =>
  assert.rejects(p, (e) => e instanceof OAuthError && e.kind === kind && re.test(e.message) && !/AT-|RT-/.test(e.message));

test("a fresh token is returned without contacting the provider", async () => {
  const s = setup();
  s.connect(30 * 60_000);
  assert.equal(await s.tokens.forModule("spotify").token("spotify"), "AT-1");
  assert.equal(s.refreshes.length, 0);
});

test("a token expiring within a minute is refreshed, stored and returned", async () => {
  const s = setup();
  s.connect(30_000);
  assert.equal(await s.tokens.token("spotify", "spotify"), "AT-2");
  assert.deepEqual(s.refreshes, [{ rt: "RT-1", scopes: ["playlist-read-private"] }]);
  const conn = s.store.get("spotify")!;
  assert.equal(conn.expiresAt, new Date(T0 + 3600_000).toISOString());
  assert.deepEqual(s.store.secrets("spotify"), { clientSecret: "s", accessToken: "AT-2", refreshToken: "RT-1" }, "no new refresh token keeps the old one");
  assert.equal(await s.tokens.token("spotify", "spotify"), "AT-2");
  assert.equal(s.refreshes.length, 1, "the refreshed token is used afterwards");
});

test("a rotated refresh token and reported scopes are stored", async () => {
  const s = setup({ refresh: async () => new arctic.OAuth2Tokens({ access_token: "AT-3", refresh_token: "RT-2", expires_in: 3600, scope: "playlist-read-private user-read-email" }) });
  s.connect(0);
  assert.equal(await s.tokens.token("spotify", "spotify"), "AT-3");
  assert.equal(s.store.secrets("spotify").refreshToken, "RT-2");
  assert.deepEqual(s.store.get("spotify")!.grantedScopes, ["playlist-read-private", "user-read-email"]);
});

test("concurrent calls share one refresh", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const s = setup({ refresh: async () => { await gate; return new arctic.OAuth2Tokens({ access_token: "AT-2", expires_in: 3600 }); } });
  s.connect(-1000);
  s.store.grant("spotify", "sonos");
  const a = s.tokens.token("spotify", "spotify");
  const b = s.tokens.token("spotify", "sonos");
  release();
  assert.deepEqual(await Promise.all([a, b]), ["AT-2", "AT-2"]);
  assert.equal(s.refreshes.length, 1);
});

test("a refresh that resolves after the connection got a new client is discarded", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const s = setup({ refresh: async () => { await gate; return new arctic.OAuth2Tokens({ access_token: "AT-OLD-CLIENT", expires_in: 3600 }); } });
  s.connect(0);
  const pending = s.tokens.token("spotify", "spotify");
  s.store.upsert({ provider: "spotify", clientId: "new-client", clientSecret: "new" });
  release();
  await rejects(pending, "not_connected", /was changed while its login was being refreshed/);
  const conn = s.store.get("spotify")!;
  assert.equal(conn.state, "disconnected");
  assert.equal(conn.hasTokens, false, "the old client's tokens were not written back");
});

test("a refresh the provider refuses sets error and rejects with refresh_failed", async () => {
  const s = setup({ refresh: async () => { throw new arctic.OAuth2RequestError("invalid_grant", "Refresh token revoked", null, null); } });
  s.connect(0);
  await rejects(s.tokens.token("spotify", "spotify"), "refresh_failed", /^Spotify needs to be reconnected under Settings > Connections: refreshing the login was refused: invalid_grant: Refresh token revoked$/);
  const conn = s.store.get("spotify")!;
  assert.equal(conn.state, "error");
  assert.equal(conn.error, "refreshing the login was refused: invalid_grant: Refresh token revoked");
  await rejects(s.tokens.token("spotify", "spotify"), "refresh_failed", /needs to be reconnected/);
  assert.equal(s.refreshes.length, 1, "an error connection is not refreshed again");
});

test("a network failure or a provider server error leaves the connection connected", async () => {
  for (const error of [new arctic.ArcticFetchError(new Error("ECONNRESET")), new arctic.UnexpectedResponseError(503)]) {
    const s = setup({ refresh: async () => { throw error; } });
    s.connect(0);
    await rejects(s.tokens.token("spotify", "spotify"), "refresh_failed", /^Spotify could not be reached to refresh the login \((network error|HTTP 503)\)\. Try again in a moment\.$/);
    assert.equal(s.store.get("spotify")!.state, "connected");
    assert.equal(s.warnings.length, 1);
    assert.ok(!/AT-|RT-/.test(s.warnings[0]!));
  }
});

test("without refresh support or a refresh token the connection moves to error when the token expires", async () => {
  const noRefresh = setup({ canRefresh: false });
  noRefresh.connect(0);
  await rejects(noRefresh.tokens.token("spotify", "spotify"), "refresh_failed", /Spotify does not refresh logins/);
  assert.equal(noRefresh.store.get("spotify")!.state, "error");

  const noToken = setup();
  noToken.connect(0, "");
  await rejects(noToken.tokens.token("spotify", "spotify"), "refresh_failed", /no refresh token was stored/);
  assert.equal(noToken.store.get("spotify")!.state, "error");
});

test("a token without an expiry is used as is", async () => {
  const s = setup();
  s.connect(undefined);
  s.setNow(T0 + 365 * 86400_000);
  assert.equal(await s.tokens.token("spotify", "spotify"), "AT-1");
  assert.equal(s.refreshes.length, 0);
});

test("not set up, not granted, not requested and revoked", async () => {
  const s = setup();
  await rejects(s.tokens.token("spotify", "spotify"), "not_connected", /^Spotify is not connected yet\. Connect it under Settings > Connections\.$/);
  s.store.upsert({ provider: "spotify", clientId: "id" });
  await rejects(s.tokens.token("spotify", "spotify"), "not_granted", /^Spotify access is not granted to spotify yet\. Grant it under Settings > Connections\.$/);
  s.store.grant("spotify", "spotify");
  await rejects(s.tokens.token("spotify", "spotify"), "not_connected", /Spotify is not connected yet/);
  await rejects(s.tokens.token("spotify", "travel"), "not_granted", /travel does not request access to Spotify/);
  s.connect(3600_000);
  assert.equal(await s.tokens.token("spotify", "spotify"), "AT-1");
  s.store.revoke("spotify", "spotify");
  await rejects(s.tokens.token("spotify", "spotify"), "not_granted", /not granted to spotify/);
  s.store.delete("spotify");
  await rejects(s.tokens.token("spotify", "spotify"), "not_connected", /not connected yet/);
});

test("a grant stays while its module is out of the list and applies again when it returns", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db, migrations, quiet);
  const store = new OAuthStore(db, randomBytes(32), quiet);
  let list: ModuleManifest[] = manifests;
  const tokens = new OAuthTokens({ store, requests: new OAuthRequests(() => list), redirectUri: () => "https://friday.example/cb" });
  store.upsert({ provider: "spotify", clientId: "id" });
  store.storeTokens("spotify", { accessToken: "AT-1", expiresAt: new Date(Date.now() + 3600_000) });
  store.grant("spotify", "spotify");
  list = manifests.filter((m) => m.id !== "spotify");
  await rejects(tokens.token("spotify", "spotify"), "not_granted", /does not request access/);
  assert.deepEqual(store.grants("spotify"), ["spotify"]);
  list = manifests;
  assert.equal(await tokens.token("spotify", "spotify"), "AT-1");
});

test("without a master key the call rejects with not_connected naming the key", async () => {
  const s = setup({ masterKey: undefined });
  s.connect(3600_000);
  await rejects(s.tokens.token("spotify", "spotify"), "not_connected", /FRIDAY_MASTER_KEY is not set/);
});

test("an unreadable token rejects with refresh_failed and puts the connection in error", async () => {
  const s = setup();
  s.connect(3600_000);
  s.db.prepare("UPDATE oauth_connections SET access_token_tag = ? WHERE provider = 'spotify'").run(randomBytes(16));
  await rejects(s.tokens.token("spotify", "spotify"), "refresh_failed", /cannot be decrypted/);
  assert.equal(s.store.get("spotify")!.state, "error");
});

test("refreshNow refreshes a connection that no module asked for or holds a grant on", async () => {
  const s = setup();
  s.connect(30 * 60_000);
  s.store.revoke("spotify", "spotify");
  assert.deepEqual(await s.tokens.refreshNow("spotify"), { result: "refreshed" });
  assert.deepEqual(s.refreshes, [{ rt: "RT-1", scopes: [] }], "no grants: only the extra scopes are asked for");
  const conn = s.store.get("spotify")!;
  assert.equal(conn.state, "connected");
  assert.equal(conn.expiresAt, new Date(T0 + 3600_000).toISOString());
  assert.equal(s.store.secrets("spotify").accessToken, "AT-2");
});

test("refreshNow asks for the granted modules' scopes", async () => {
  const s = setup();
  s.connect(30 * 60_000);
  await s.tokens.refreshNow("spotify");
  assert.deepEqual(s.refreshes, [{ rt: "RT-1", scopes: ["playlist-read-private"] }]);
});

test("refreshNow skips connections it cannot or should not refresh, without changing them", async () => {
  const none = setup();
  assert.deepEqual(await none.tokens.refreshNow("spotify"), { result: "skipped", reason: "not connected" });

  const disconnected = setup();
  disconnected.store.upsert({ provider: "spotify", clientId: "id" });
  assert.deepEqual(await disconnected.tokens.refreshNow("spotify"), { result: "skipped", reason: "not connected" });

  const broken = setup();
  broken.connect(0);
  broken.store.setError("spotify", "earlier failure");
  assert.deepEqual(await broken.tokens.refreshNow("spotify"), { result: "skipped", reason: "not connected" });
  assert.equal(broken.store.get("spotify")!.error, "earlier failure");

  const noRefresh = setup({ canRefresh: false });
  noRefresh.connect(0);
  assert.deepEqual(await noRefresh.tokens.refreshNow("spotify"), { result: "skipped", reason: "Spotify does not refresh logins" });
  assert.equal(noRefresh.store.get("spotify")!.state, "connected");

  const noToken = setup();
  noToken.connect(0, "");
  assert.deepEqual(await noToken.tokens.refreshNow("spotify"), { result: "skipped", reason: "no refresh token was stored" });
  assert.equal(noToken.store.get("spotify")!.state, "connected");

  for (const s of [none, disconnected, broken, noRefresh, noToken]) assert.equal(s.refreshes.length, 0);
});

test("refreshNow skips everything without a master key", async () => {
  const s = setup({ masterKey: undefined });
  assert.deepEqual(await s.tokens.refreshNow("spotify"), { result: "skipped", reason: "FRIDAY_MASTER_KEY is not set" });
  assert.equal(s.refreshes.length, 0);
});

test("refreshNow reports a refusal as error, with the connection in error", async () => {
  const s = setup({ refresh: async () => { throw new arctic.OAuth2RequestError("invalid_grant", "Refresh token revoked", null, null); } });
  s.connect(30 * 60_000);
  assert.deepEqual(await s.tokens.refreshNow("spotify"), { result: "error", message: "refreshing the login was refused: invalid_grant: Refresh token revoked" });
  assert.equal(s.store.get("spotify")!.state, "error");
});

test("refreshNow reports a network failure or server error as retry, leaving the connection connected", async () => {
  for (const [error, reason] of [[new arctic.ArcticFetchError(new Error("ECONNRESET")), "network error"], [new arctic.UnexpectedResponseError(503), "HTTP 503"]] as const) {
    const s = setup({ refresh: async () => { throw error; } });
    s.connect(30 * 60_000);
    assert.deepEqual(await s.tokens.refreshNow("spotify"), { result: "retry", message: reason });
    assert.equal(s.store.get("spotify")!.state, "connected");
  }
});

test("refreshNow reports an unreadable token as error", async () => {
  const s = setup();
  s.connect(30 * 60_000);
  s.db.prepare("UPDATE oauth_connections SET refresh_token_tag = ? WHERE provider = 'spotify'").run(randomBytes(16));
  const outcome = await s.tokens.refreshNow("spotify");
  assert.equal(outcome.result, "error");
  assert.match((outcome as { message: string }).message, /refresh token cannot be decrypted/);
  assert.equal(s.store.get("spotify")!.state, "error");
  assert.equal(s.refreshes.length, 0);
});

test("refreshNow discards a refresh whose connection got a new client meanwhile", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const s = setup({ refresh: async () => { await gate; return new arctic.OAuth2Tokens({ access_token: "AT-OLD-CLIENT", expires_in: 3600 }); } });
  s.connect(30 * 60_000);
  const pending = s.tokens.refreshNow("spotify");
  await new Promise((r) => setImmediate(r));
  s.store.upsert({ provider: "spotify", clientId: "new-client", clientSecret: "new" });
  release();
  assert.deepEqual(await pending, { result: "changed" });
  assert.equal(s.store.get("spotify")!.hasTokens, false);
});

test("refreshNow and a module's token call share one refresh", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const s = setup({ refresh: async () => { await gate; return new arctic.OAuth2Tokens({ access_token: "AT-2", expires_in: 3600 }); } });
  s.connect(30_000);
  const job = s.tokens.refreshNow("spotify");
  await new Promise((r) => setImmediate(r));
  const call = s.tokens.token("spotify", "spotify");
  release();
  assert.deepEqual(await job, { result: "refreshed" });
  assert.equal(await call, "AT-2");
  assert.equal(s.refreshes.length, 1);
});
