import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { migrate, migrations } from "../src/storage/db.js";
import { OAuthDecryptError, OAuthInputError, OAuthStore, OAuthStoreDisabled, parseConnectionInput } from "../src/oauth/store.js";

const quiet = { log() {}, error() {} };
const key = randomBytes(32);
const memDb = () => { const d = new DatabaseSync(":memory:"); d.exec("PRAGMA foreign_keys = ON"); migrate(d, migrations, quiet); return d; };
const spotify = { provider: "spotify", clientId: "client-1", clientSecret: "sh-secret" };
const tokens = { accessToken: "AT-1", refreshToken: "RT-1", expiresAt: new Date("2026-10-21T13:00:00Z"), grantedScopes: ["playlist-read-private"] };

const raw = (db: DatabaseSync, provider = "spotify") => db.prepare("SELECT * FROM oauth_connections WHERE provider = ?").get(provider) as Record<string, unknown>;

test("the client secret and tokens are ciphertext at rest, the client id is readable", () => {
  const db = memDb();
  const store = new OAuthStore(db, key, quiet);
  store.upsert(spotify);
  store.storeTokens("spotify", tokens);
  const row = raw(db);
  assert.equal(row.client_id, "client-1");
  const dump = JSON.stringify(Object.values(row).map((v) => (v instanceof Uint8Array ? Buffer.from(v).toString("latin1") : v)));
  for (const secret of ["sh-secret", "AT-1", "RT-1"]) assert.ok(!dump.includes(secret), `${secret} is stored in the clear`);
  assert.deepEqual(store.secrets("spotify"), { clientSecret: "sh-secret", accessToken: "AT-1", refreshToken: "RT-1" });
  const stored = store.get("spotify")!;
  assert.equal(stored.state, "connected");
  assert.equal(stored.hasClientSecret, true);
  assert.equal(stored.hasTokens, true);
  assert.equal(stored.expiresAt, "2026-10-21T13:00:00.000Z");
  assert.deepEqual(stored.grantedScopes, ["playlist-read-private"]);
  assert.ok(!JSON.stringify(stored).includes("sh-secret"));
});

test("a ciphertext moved to another field or provider fails to decrypt and puts the connection in error", () => {
  const db = memDb();
  const errors: string[] = [];
  const store = new OAuthStore(db, key, { error: (m: string) => errors.push(m) });
  store.upsert(spotify);
  store.upsert({ provider: "github", clientId: "gh", clientSecret: "gh-secret" });
  store.storeTokens("spotify", tokens);
  // Access token sealed for spotify, copied into github's refresh token.
  db.prepare(`UPDATE oauth_connections SET refresh_token_ct = (SELECT access_token_ct FROM oauth_connections WHERE provider = 'spotify'),
    refresh_token_iv = (SELECT access_token_iv FROM oauth_connections WHERE provider = 'spotify'),
    refresh_token_tag = (SELECT access_token_tag FROM oauth_connections WHERE provider = 'spotify') WHERE provider = 'github'`).run();
  assert.throws(() => store.secrets("github"), OAuthDecryptError);
  assert.equal(store.get("github")!.state, "error");
  assert.match(store.get("github")!.error!, /refresh token cannot be decrypted/);
  assert.equal(errors.length, 1);
  assert.ok(!errors[0]!.includes("AT-1"));
  // Within one provider, a field moved to another field fails too.
  db.prepare("UPDATE oauth_connections SET refresh_token_ct = access_token_ct, refresh_token_iv = access_token_iv, refresh_token_tag = access_token_tag WHERE provider = 'spotify'").run();
  assert.throws(() => store.secrets("spotify"), OAuthDecryptError);
});

test("a wrong master key puts the connection in error", () => {
  const db = memDb();
  new OAuthStore(db, key, quiet).upsert(spotify);
  const other = new OAuthStore(db, randomBytes(32), quiet);
  assert.throws(() => other.secrets("spotify"), OAuthDecryptError);
  assert.equal(other.get("spotify")!.state, "error");
});

test("without a master key nothing is saved or read", () => {
  const db = memDb();
  const store = new OAuthStore(db, undefined, quiet);
  assert.equal(store.secretsEnabled, false);
  assert.throws(() => store.upsert(spotify), OAuthStoreDisabled);
  assert.throws(() => store.upsert({ provider: "github", clientId: "gh" }), OAuthStoreDisabled);
  new OAuthStore(db, key, quiet).upsert(spotify);
  assert.throws(() => store.secrets("spotify"), OAuthStoreDisabled);
  assert.throws(() => store.storeTokens("spotify", tokens), OAuthStoreDisabled);
});

test("a new connection starts disconnected; a new client id, secret or URL clears the tokens", () => {
  const db = memDb();
  const store = new OAuthStore(db, key, quiet);
  assert.equal(store.upsert(spotify).state, "disconnected");
  const connect = () => { store.storeTokens("spotify", tokens); assert.equal(store.get("spotify")!.state, "connected"); };

  connect();
  const sameSecretKept = store.upsert({ provider: "spotify", clientId: "client-1" });
  assert.equal(sameSecretKept.state, "connected", "leaving the secret out keeps it and the tokens");
  assert.equal(store.secrets("spotify").clientSecret, "sh-secret");

  const extras = store.upsert({ provider: "spotify", clientId: "client-1", extraScopes: ["user-read-email"] });
  assert.equal(extras.state, "connected", "extra scopes alone keep the tokens");
  assert.deepEqual(extras.extraScopes, ["user-read-email"]);
  assert.deepEqual(store.upsert({ provider: "spotify", clientId: "client-1" }).extraScopes, ["user-read-email"], "leaving extras out keeps them");

  const newSecret = store.upsert({ provider: "spotify", clientId: "client-1", clientSecret: "new" });
  assert.equal(newSecret.state, "disconnected");
  assert.equal(newSecret.hasTokens, false);
  assert.equal(newSecret.expiresAt, undefined);
  assert.equal(newSecret.grantedScopes, undefined);
  assert.equal(store.secrets("spotify").clientSecret, "new");

  connect();
  assert.equal(store.upsert({ provider: "spotify", clientId: "client-2" }).state, "disconnected", "a new client id clears");

  store.upsert({ provider: "acme", clientId: "a", authUrl: "https://acme.example/a", tokenUrl: "https://acme.example/t" });
  store.storeTokens("acme", tokens);
  assert.equal(store.upsert({ provider: "acme", clientId: "a", authUrl: "https://acme.example/a", tokenUrl: "https://acme.example/t2" }).state, "disconnected", "a new URL clears");
});

test("a refresh without a new refresh token keeps the old one; an error is cleared by new tokens", () => {
  const db = memDb();
  const store = new OAuthStore(db, key, quiet);
  store.upsert(spotify);
  store.storeTokens("spotify", tokens);
  store.setError("spotify", "boom");
  assert.equal(store.get("spotify")!.state, "error");
  store.storeTokens("spotify", { accessToken: "AT-2", expiresAt: new Date("2026-10-21T14:00:00Z") });
  assert.deepEqual(store.secrets("spotify"), { clientSecret: "sh-secret", accessToken: "AT-2", refreshToken: "RT-1" });
  const s = store.get("spotify")!;
  assert.equal(s.state, "connected");
  assert.equal(s.error, undefined);
  assert.deepEqual(s.grantedScopes, ["playlist-read-private"], "granted scopes are kept when a refresh reports none");
});

test("grants need the connection, and deleting the connection deletes its grants", () => {
  const db = memDb();
  const store = new OAuthStore(db, key, quiet);
  assert.equal(store.grant("spotify", "spotify"), false);
  store.upsert(spotify);
  assert.equal(store.grant("spotify", "spotify"), true);
  assert.equal(store.grant("spotify", "spotify"), true, "granting twice is fine");
  assert.equal(store.grant("spotify", "sonos"), true);
  assert.deepEqual(store.grants("spotify"), ["sonos", "spotify"]);
  assert.equal(store.revoke("spotify", "sonos"), true);
  assert.equal(store.hasGrant("spotify", "sonos"), false);
  assert.equal(store.hasGrant("spotify", "spotify"), true);
  assert.equal(store.delete("spotify"), true);
  assert.equal(store.delete("spotify"), false);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM oauth_grants").get() as { n: number }).n, 0);
});

test("parseConnectionInput validates the body", () => {
  assert.deepEqual(parseConnectionInput("spotify", { clientId: " id ", clientSecret: "s", extraScopes: ["a", "a", " b "] }), { provider: "spotify", clientId: "id", clientSecret: "s", extraScopes: ["a", "b"] });
  assert.deepEqual(parseConnectionInput("acme", { clientId: "id", authUrl: "https://acme.example/a", tokenUrl: "https://acme.example/t" }), { provider: "acme", clientId: "id", authUrl: "https://acme.example/a", tokenUrl: "https://acme.example/t" });
  const bad: [string, unknown, RegExp][] = [
    ["Spotify", { clientId: "x" }, /provider must be kebab-case/],
    ["spotify", [], /JSON object/],
    ["spotify", {}, /clientId is required/],
    ["spotify", { clientId: "x", clientSecret: "" }, /clientSecret must be a non-empty string/],
    ["spotify", { clientId: "x", extraScopes: ["a b"] }, /extraScopes must be a list of scopes without spaces/],
    ["spotify", { clientId: "x", authUrl: "https://x.example" }, /authUrl is only for generic providers/],
    ["acme", { clientId: "x", authUrl: "https://acme.example/a" }, /a generic provider needs tokenUrl/],
    ["acme", { clientId: "x", authUrl: "https://acme.example/a", tokenUrl: "http://acme.example/t" }, /tokenUrl must be an https URL/],
  ];
  for (const [provider, body, re] of bad) assert.throws(() => parseConnectionInput(provider, body), (e) => e instanceof OAuthInputError && re.test((e as Error).message), `${provider} ${JSON.stringify(body)}`);
});
