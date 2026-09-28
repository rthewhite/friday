import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { migrate, migrations } from "../src/storage/db.js";
import { ConfigStore, GLOBAL_SCOPE } from "../src/secrets/config-store.js";
import { CORE_ID, coreConfig, coreManifest } from "../src/core-config.js";

const store = () => {
  const db = new DatabaseSync(":memory:");
  migrate(db, migrations, { log() {} });
  return new ConfigStore(db, randomBytes(32));
};

test("core declares GEMINI_API_KEY as a required secret", () => {
  assert.equal(coreManifest.id, "core");
  assert.deepEqual(coreManifest.config?.map(({ key, secret, required }) => ({ key, secret, required })), [{ key: "GEMINI_API_KEY", secret: true, required: true }]);
});

test("core keys resolve core scope, then global, then env, read at each use", () => {
  const s = store();
  const get = coreConfig(s, { GEMINI_API_KEY: "from-env" });
  assert.equal(get("GEMINI_API_KEY"), "from-env");
  s.set(GLOBAL_SCOPE, "GEMINI_API_KEY", "from-global", { secret: true });
  assert.equal(get("GEMINI_API_KEY"), "from-global");
  s.set(CORE_ID, "GEMINI_API_KEY", "from-core", { secret: true });
  assert.equal(get("GEMINI_API_KEY"), "from-core");
  s.delete(CORE_ID, "GEMINI_API_KEY");
  s.delete(GLOBAL_SCOPE, "GEMINI_API_KEY");
  assert.equal(get("GEMINI_API_KEY"), "from-env");
  assert.equal(coreConfig(s, {})("GEMINI_API_KEY"), undefined);
});
