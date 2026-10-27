import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import * as arctic from "arctic";
import type { JobResult, ModuleManifest } from "@friday/sdk";
import { migrate, migrations } from "../src/storage/db.js";
import { OAuthStore } from "../src/oauth/store.js";
import { OAuthRequests } from "../src/oauth/requests.js";
import { OAuthTokens } from "../src/oauth/tokens.js";
import { keepaliveJob, registerOAuthKeepalive } from "../src/oauth/keepalive.js";
import type { BuildClient } from "../src/oauth/catalogue.js";
import { JobStore } from "../src/jobs/store.js";
import { Scheduler } from "../src/jobs/scheduler.js";
import { FakeClock } from "./fake-clock.js";

const T0 = Date.parse("2026-10-27T12:00:00Z");
const quiet = { log() {}, warn() {}, error() {} };
const manifests: ModuleManifest[] = [{ id: "spotify", label: "Spotify", oauth: [{ provider: "spotify", scopes: ["playlist-read-private"] }] }];
const fresh = () => new arctic.OAuth2Tokens({ access_token: "AT-NEW", expires_in: 3600 });

type Refresh = (provider: string) => Promise<arctic.OAuth2Tokens>;

interface Setup {
  refresh?: Refresh;
  noRefresh?: string[];
  masterKey?: Buffer | undefined;
}

function setup(o: Setup = {}) {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db, migrations, quiet);
  const now = T0;
  const key = "masterKey" in o ? o.masterKey : randomBytes(32);
  const keyed = new OAuthStore(db, key ?? randomBytes(32), quiet, () => new Date(now));
  const store = key === undefined ? new OAuthStore(db, undefined, quiet) : keyed;
  const requests: string[] = [];
  const buildClient: BuildClient = (config) => ({
    pkce: true,
    refresh: !(o.noRefresh ?? []).includes(config.provider),
    authorizationUrl: () => new URL("https://accounts.example/authorize"),
    exchange: async () => { throw new Error("not used"); },
    refreshToken: async () => {
      requests.push(config.provider);
      return o.refresh ? o.refresh(config.provider) : fresh();
    },
  });
  const warnings: string[] = [];
  const tokens = new OAuthTokens({
    store,
    requests: new OAuthRequests(() => manifests),
    redirectUri: (p) => `https://friday.example/api/oauth/${p}/callback`,
    buildClient,
    now: () => now,
    log: { warn: (m: string) => warnings.push(m) },
  });
  /** A connected provider whose access token is still valid for half an hour: nobody would refresh it today. */
  const connect = (provider: string, refreshToken: string | undefined = `RT-${provider}`) => {
    keyed.upsert({ provider, clientId: `id-${provider}`, clientSecret: `secret-${provider}` });
    keyed.storeTokens(provider, { accessToken: `AT-${provider}`, ...(refreshToken && { refreshToken }), expiresAt: new Date(now + 30 * 60_000) });
  };
  const logs: string[] = [];
  const log = { log: (m: string) => logs.push(m), warn: (m: string) => logs.push(m), error: (m: string) => logs.push(m) };
  const run = (signal = new AbortController().signal) => keepaliveJob(tokens, store).run({ signal, log, trigger: "schedule" }) as Promise<JobResult>;
  return { db, store: keyed, tokens, requests, warnings, logs, connect, run };
}

const noSecrets = (...texts: string[]) => {
  for (const t of texts) assert.ok(!/AT-|RT-|secret-/.test(t), `no token or client secret in: ${t}`);
};

test("an unused connection is refreshed and stays connected with a later expiry", async () => {
  const s = setup();
  s.connect("spotify");
  const before = s.store.get("spotify")!.expiresAt;
  assert.deepEqual(await s.run(), { summary: "refreshed 1" });
  assert.deepEqual(s.requests, ["spotify"]);
  const conn = s.store.get("spotify")!;
  assert.equal(conn.state, "connected");
  assert.ok(Date.parse(conn.expiresAt!) > Date.parse(before!));
  assert.equal(s.store.secrets("spotify").accessToken, "AT-NEW");
});

test("a connection no module requests or holds a grant on is refreshed too", async () => {
  const s = setup();
  s.connect("github");
  assert.deepEqual(await s.run(), { summary: "refreshed 1" });
  assert.deepEqual(s.requests, ["github"]);
});

test("a login revoked at the provider fails the run, naming the provider and the reason", async () => {
  const s = setup({ refresh: async () => { throw new arctic.OAuth2RequestError("invalid_grant", "Refresh token revoked", null, null); } });
  s.connect("spotify");
  await assert.rejects(s.run(), { message: "refreshed 0; needs reconnect: Spotify (refreshing the login was refused: invalid_grant: Refresh token revoked)" });
  const conn = s.store.get("spotify")!;
  assert.equal(conn.state, "error");
  assert.equal(conn.error, "refreshing the login was refused: invalid_grant: Refresh token revoked");
  assert.equal(s.logs.length, 1);
  noSecrets(...s.logs);
});

test("an unreachable provider is retried next run and leaves the run ok", async () => {
  const s = setup({ refresh: async () => { throw new arctic.ArcticFetchError(new Error("ECONNRESET")); } });
  s.connect("spotify");
  assert.deepEqual(await s.run(), { summary: "refreshed 0; retry next run: Spotify (network error)" });
  assert.equal(s.store.get("spotify")!.state, "connected");
});

test("one broken login among working ones fails the run and still refreshes the others", async () => {
  const s = setup({
    refresh: async (p) => {
      if (p === "dropbox") throw new arctic.OAuth2RequestError("invalid_grant", null, null, null);
      if (p === "github") throw new arctic.UnexpectedResponseError(503);
      return fresh();
    },
  });
  for (const p of ["dropbox", "github", "spotify"]) s.connect(p);
  const err = await s.run().then(() => undefined, (e: Error) => e);
  assert.equal(err?.message, "refreshed 1; needs reconnect: Dropbox (refreshing the login was refused: invalid_grant); retry next run: GitHub (HTTP 503)");
  noSecrets(err!.message, ...s.logs, ...s.warnings);
  assert.deepEqual(s.requests, ["dropbox", "github", "spotify"]);
  assert.deepEqual(["dropbox", "github", "spotify"].map((p) => s.store.get(p)!.state), ["error", "connected", "connected"]);
});

test("disconnected, broken and non-refreshing connections are left alone", async () => {
  const s = setup({ noRefresh: ["anilist"] });
  s.store.upsert({ provider: "github", clientId: "id" }); // disconnected
  s.connect("dropbox");
  s.store.setError("dropbox", "earlier failure");
  s.connect("anilist"); // cannot refresh
  s.connect("spotify", ""); // no refresh token
  assert.deepEqual(await s.run(), { summary: "refreshed 0; skipped 2" });
  assert.deepEqual(s.requests, []);
  assert.deepEqual(["github", "dropbox", "anilist", "spotify"].map((p) => s.store.get(p)!.state), ["disconnected", "error", "connected", "connected"]);
  assert.equal(s.store.get("dropbox")!.error, "earlier failure");
});

test("without a master key nothing is refreshed and the summary says why", async () => {
  const s = setup({ masterKey: undefined });
  s.connect("spotify");
  assert.deepEqual(await s.run(), { summary: "nothing refreshed: FRIDAY_MASTER_KEY is not set" });
  assert.deepEqual(s.requests, []);
});

test("an unreadable token puts the connection in error and fails the run", async () => {
  const s = setup();
  s.connect("spotify");
  s.db.prepare("UPDATE oauth_connections SET refresh_token_tag = ? WHERE provider = 'spotify'").run(randomBytes(16));
  await assert.rejects(s.run(), /^Error: refreshed 0; needs reconnect: Spotify \(the stored refresh token cannot be decrypted/);
  assert.equal(s.store.get("spotify")!.state, "error");
});

test("an aborted run stops before the next connection", async () => {
  const ac = new AbortController();
  const s = setup({ refresh: async () => { ac.abort(); return fresh(); } });
  s.connect("dropbox");
  s.connect("spotify");
  assert.deepEqual(await s.run(ac.signal), { summary: "refreshed 1" });
  assert.deepEqual(s.requests, ["dropbox"]);
});

test("the run shares a refresh with a module's token call", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const s = setup({ refresh: async () => { await gate; return fresh(); } });
  s.connect("spotify");
  s.store.grant("spotify", "spotify");
  s.db.prepare("UPDATE oauth_connections SET expires_at = ? WHERE provider = 'spotify'").run(new Date(T0 + 10_000).toISOString());
  const run = s.run();
  await new Promise((r) => setImmediate(r));
  const call = s.tokens.token("spotify", "spotify");
  release();
  assert.deepEqual(await run, { summary: "refreshed 1" });
  assert.equal(await call, "AT-NEW");
  assert.deepEqual(s.requests, ["spotify"]);
});

test("registers core/oauth-keepalive at 05:00, and a manual run refreshes without moving the schedule", async () => {
  const s = setup();
  s.connect("spotify");
  const clock = new FakeClock(T0);
  const jobStore = new JobStore(s.db, 50);
  const scheduler = new Scheduler({ store: jobStore, timezone: "Europe/Amsterdam", clock, log: quiet });
  registerOAuthKeepalive(scheduler, s.tokens, s.store);
  const [job] = scheduler.list();
  assert.equal(job.id, "core/oauth-keepalive");
  assert.deepEqual(job.schedule, { cron: "0 5 * * *", timezone: "Europe/Amsterdam" });
  assert.equal(job.nextRunAt, "2026-10-28T04:00:00.000Z", "05:00 Amsterdam, winter time");
  assert.equal(scheduler.runNow("core/oauth-keepalive").status, "started");
  await clock.advance(0);
  const [run] = jobStore.runs("core/oauth-keepalive");
  assert.equal(run.trigger, "manual");
  assert.equal(run.outcome, "ok");
  assert.equal(run.summary, "refreshed 1");
  assert.deepEqual(s.requests, ["spotify"]);
  assert.equal(scheduler.list()[0].nextRunAt, "2026-10-28T04:00:00.000Z");
  await scheduler.stop();
});
