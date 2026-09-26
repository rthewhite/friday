import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
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

test("ConfigStore stores ciphertext, reads plaintext, lists keys, and caches until write", () => {
  const d = db();
  const s = new ConfigStore(d, key, quiet);
  assert.equal(s.enabled, true);
  s.set("media", "JELLYFIN_URL", "http://jf");
  const row = d.prepare("SELECT ciphertext FROM config_values").get() as { ciphertext: Uint8Array };
  assert.ok(!Buffer.from(row.ciphertext).toString().includes("http://jf"));
  assert.equal(s.get("media", "JELLYFIN_URL"), "http://jf");
  s.set("media", "JELLYFIN_URL", "http://jf2");
  assert.equal(s.get("media", "JELLYFIN_URL"), "http://jf2");
  s.set("global", "HA_URL", "http://ha");
  assert.deepEqual(s.keys(), [{ scope: "global", key: "HA_URL" }, { scope: "media", key: "JELLYFIN_URL" }]);
  assert.equal(s.delete("media", "JELLYFIN_URL"), true);
  assert.equal(s.get("media", "JELLYFIN_URL"), undefined);
  assert.equal(s.has("global", "HA_URL"), true);
});

test("disabled store: reads yield undefined, writes throw ConfigStoreDisabled", () => {
  const s = new ConfigStore(db(), undefined, quiet);
  assert.equal(s.enabled, false);
  assert.equal(s.get("media", "X"), undefined);
  assert.throws(() => s.set("media", "X", "1"), ConfigStoreDisabled);
  assert.throws(() => s.delete("media", "X"), ConfigStoreDisabled);
});

test("wrong master key: rows are reported by verifyAll, treated as unset, and status is pending", () => {
  const d = db();
  new ConfigStore(d, key, quiet).set("media", "JELLYFIN_API_KEY", "x");
  const errors: string[] = [];
  const s = new ConfigStore(d, randomBytes(32), { error: (m: string) => errors.push(m) });
  assert.deepEqual(s.verifyAll(), [{ scope: "media", key: "JELLYFIN_API_KEY" }]);
  assert.equal(s.get("media", "JELLYFIN_API_KEY"), undefined);
  assert.ok(errors[0].includes("cannot decrypt media/JELLYFIN_API_KEY"));
  assert.deepEqual(statusOf(s, {}, "media", "JELLYFIN_API_KEY"), { status: "pending" });
});

test("resolver order: module scope, global scope, env; status reports the source", () => {
  const s = new ConfigStore(db(), key, quiet);
  const env = { HA_URL: "http://env", ONLY_ENV: "e" };
  const resolve = createResolver(s, env);
  s.set("global", "HA_URL", "http://global");
  s.set("media", "HA_URL", "http://media");
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
  s.set("other", "NOPE", "now");
  assert.equal(r("NOPE"), "now");
});
