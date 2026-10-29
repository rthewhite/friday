import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/storage/db.js";
import { MemoryModuleEnablement, SqliteModuleEnablement } from "../src/storage/module-enablement.js";

const quiet = { log() {} };

async function store() {
  const db = openDatabase(await mkdtemp(join(tmpdir(), "friday-enable-")), "friday.db", quiet);
  return { db, store: new SqliteModuleEnablement(db) };
}

test("a module without a stored choice is enabled", async () => {
  const { db, store: s } = await store();
  assert.equal(s.isEnabled("sonos"), true);
  db.close();
});

test("a choice is stored, switched back, and keeps one row with its time", async () => {
  const { db, store: s } = await store();
  s.set("sonos", false);
  assert.equal(s.isEnabled("sonos"), false);
  assert.equal(s.isEnabled("media"), true, "other modules are unaffected");
  s.set("sonos", true);
  assert.equal(s.isEnabled("sonos"), true);
  const rows = db.prepare("SELECT module_id, enabled, updated_at FROM module_enablement").all() as { module_id: string; enabled: number; updated_at: string }[];
  assert.equal(rows.length, 1);
  assert.equal(rows[0].enabled, 1);
  assert.ok(!Number.isNaN(Date.parse(rows[0].updated_at)));
  db.close();
});

test("a row for an id no module has is kept and harmless", async () => {
  const { db, store: s } = await store();
  s.set("gone", false);
  assert.equal(s.isEnabled("gone"), false);
  assert.equal(s.isEnabled("builtin"), true);
  db.close();
});

test("the in-memory store follows the same rules", () => {
  const s = new MemoryModuleEnablement(["media"]);
  assert.equal(s.isEnabled("media"), false);
  assert.equal(s.isEnabled("builtin"), true);
  s.set("media", true);
  assert.equal(s.isEnabled("media"), true);
});
