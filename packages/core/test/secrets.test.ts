import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
import { migrate, migrations } from "../src/storage/db.js";
import { decrypt, encrypt, parseMasterKey } from "../src/secrets/crypto.js";
import { ConfigStore, ConfigStoreDisabled } from "../src/secrets/config-store.js";
import { createResolver, statusOf } from "../src/secrets/resolver.js";

const quiet = { log() {}, error() {} };
const key = randomBytes(32);
const db = () => { const d = new DatabaseSync(":memory:"); migrate(d, migrations, quiet); return d; };

test("parseMasterKey accepts 32-byte base64 (standard or url-safe) and rejects others", () => {
  assert.equal(parseMasterKey(undefined), undefined);
  assert.equal(parseMasterKey("  "), undefined);
  assert.ok(parseMasterKey(key.toString("base64"))!.equals(key));
  assert.ok(parseMasterKey(key.toString("base64url"))!.equals(key));
  assert.throws(() => parseMasterKey("c2hvcnQ="), /32 bytes, got 5/);
});

test("encrypt/decrypt round-trips; tamper, wrong key and wrong AAD fail", () => {
  const e = encrypt(key, "media", "JELLYFIN_API_KEY", "s3cret");
  assert.equal(decrypt(key, "media", "JELLYFIN_API_KEY", e), "s3cret");
  assert.throws(() => decrypt(randomBytes(32), "media", "JELLYFIN_API_KEY", e));
  assert.throws(() => decrypt(key, "global", "JELLYFIN_API_KEY", e));
  const tampered = { ...e, ciphertext: Buffer.from(e.ciphertext.map((b, i) => (i === 0 ? b ^ 1 : b))) };
  assert.throws(() => decrypt(key, "media", "JELLYFIN_API_KEY", tampered));
});

test("ConfigStore: secrets are ciphertext, plain values are plaintext, both read back, keys report kind", () => {
  const d = db();
  const s = new ConfigStore(d, key, quiet);
  assert.equal(s.secretsEnabled, true);
  s.set("media", "JELLYFIN_API_KEY", "tok", { secret: true });
  s.set("media", "JELLYFIN_URL", "http://jf", { secret: false });
  const rows = d.prepare("SELECT key, secret, plaintext, ciphertext FROM config_values ORDER BY key").all() as any[];
  assert.equal(rows[0].secret, 1);
  assert.equal(rows[0].plaintext, null);
  assert.ok(!Buffer.from(rows[0].ciphertext).toString().includes("tok"));
  assert.equal(rows[1].secret, 0);
  assert.equal(rows[1].plaintext, "http://jf");
  assert.equal(s.get("media", "JELLYFIN_API_KEY"), "tok");
  assert.equal(s.get("media", "JELLYFIN_URL"), "http://jf");
  s.set("media", "JELLYFIN_URL", "http://jf2", { secret: false });
  assert.equal(s.get("media", "JELLYFIN_URL"), "http://jf2");
  // a plain row can be promoted to secret and back
  s.set("media", "JELLYFIN_URL", "http://jf3", { secret: true });
  assert.deepEqual(s.info("media", "JELLYFIN_URL"), { secret: true });
  assert.equal(s.get("media", "JELLYFIN_URL"), "http://jf3");
  s.set("global", "HA_URL", "http://ha", { secret: false });
  assert.deepEqual(s.keys().map(({ updatedAt, ...k }) => (assert.match(updatedAt, /^\d{4}-/), k)), [{ scope: "global", key: "HA_URL", secret: false }, { scope: "media", key: "JELLYFIN_API_KEY", secret: true }, { scope: "media", key: "JELLYFIN_URL", secret: true }]);
  assert.match(s.updatedAt("global", "HA_URL")!, /^\d{4}-/);
  assert.equal(s.delete("media", "JELLYFIN_URL"), true);
  assert.equal(s.get("media", "JELLYFIN_URL"), undefined);
  assert.equal(s.info("media", "JELLYFIN_URL"), undefined);
});

test("without a master key: plain values work, secret reads are unset, secret writes throw", () => {
  const d = db();
  new ConfigStore(d, key, quiet).set("media", "T", "tok", { secret: true });
  const s = new ConfigStore(d, undefined, quiet);
  assert.equal(s.secretsEnabled, false);
  s.set("media", "URL", "http://x", { secret: false });
  assert.equal(s.get("media", "URL"), "http://x");
  assert.equal(s.get("media", "T"), undefined);
  assert.throws(() => s.set("media", "T", "1", { secret: true }), ConfigStoreDisabled);
  assert.equal(s.delete("media", "URL"), true);
});

test("rows from before the split (version 1) are treated as secret after migration 2", () => {
  const d = new DatabaseSync(":memory:");
  migrate(d, migrations.filter((m) => m.version === 1), quiet);
  // write a v1-shaped row by hand
  const { encrypt } = require("../src/secrets/crypto.js") as typeof import("../src/secrets/crypto.js");
  const e = encrypt(key, "media", "OLD", "legacy");
  d.prepare("INSERT INTO config_values (scope, key, ciphertext, iv, tag, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run("media", "OLD", e.ciphertext, e.iv, e.tag, "t");
  assert.equal(migrate(d, migrations.filter((m) => m.version <= 2), quiet), 1);
  const s = new ConfigStore(d, key, quiet);
  assert.deepEqual(s.info("media", "OLD"), { secret: true });
  assert.equal(s.get("media", "OLD"), "legacy");
});

test("wrong master key: secret rows are reported by verifyAll, treated as unset, and status is pending; plain rows unaffected", () => {
  const d = db();
  new ConfigStore(d, key, quiet).set("media", "JELLYFIN_API_KEY", "x", { secret: true });
  new ConfigStore(d, key, quiet).set("media", "JELLYFIN_URL", "http://jf", { secret: false });
  const errors: string[] = [];
  const s = new ConfigStore(d, randomBytes(32), { error: (m: string) => errors.push(m) });
  assert.deepEqual(s.verifyAll(), [{ scope: "media", key: "JELLYFIN_API_KEY" }]);
  assert.equal(s.get("media", "JELLYFIN_API_KEY"), undefined);
  assert.ok(errors[0].includes("cannot decrypt media/JELLYFIN_API_KEY"));
  assert.deepEqual(statusOf(s, {}, "media", "JELLYFIN_API_KEY"), { status: "pending" });
  assert.equal(s.get("media", "JELLYFIN_URL"), "http://jf");
});

test("resolver order: module scope, global scope, env; status reports the source", () => {
  const s = new ConfigStore(db(), key, quiet);
  const env = { HA_URL: "http://env", ONLY_ENV: "e" };
  const resolve = createResolver(s, env);
  s.set("global", "HA_URL", "http://global", { secret: false });
  s.set("media", "HA_URL", "http://media", { secret: true });
  assert.equal(resolve("media")("HA_URL"), "http://media");
  assert.equal(resolve("other")("HA_URL"), "http://global");
  assert.equal(resolve("other")("ONLY_ENV"), "e");
  assert.equal(resolve("other")("NOPE"), undefined);
  assert.deepEqual(statusOf(s, env, "media", "HA_URL"), { status: "set", scope: "media" });
  assert.deepEqual(statusOf(s, env, "other", "HA_URL"), { status: "set", scope: "global" });
  assert.deepEqual(statusOf(s, env, "other", "ONLY_ENV"), { status: "env" });
  assert.deepEqual(statusOf(s, env, "other", "NOPE"), { status: "pending" });
  // reads are live: a later write is visible without rebuilding the resolver
  const r = resolve("other");
  s.set("other", "NOPE", "now", { secret: false });
  assert.equal(r("NOPE"), "now");
});
