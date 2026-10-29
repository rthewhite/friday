import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/storage/db.js";
import { defineModule, ToolRegistry } from "@friday/sdk";
import { ModuleHost } from "../src/module-host.js";
import { MemoryModuleEnablement, retiredModulesWarning, SqliteModuleEnablement } from "../src/storage/module-enablement.js";

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

test("a FRIDAY_MODULES left in the environment gets one warning and picks nothing", async () => {
  assert.equal(retiredModulesWarning({}), undefined);
  assert.match(retiredModulesWarning({ FRIDAY_MODULES: "builtin" }) ?? "", /FRIDAY_MODULES is no longer used.*System > Modules/);

  const registry = new ToolRegistry({ log() {}, warn() {}, error() {} });
  const env = { FRIDAY_MODULES: "builtin" };
  const host = new ModuleHost(registry, { env, log: { log() {}, warn() {}, error() {} }, enablement: new MemoryModuleEnablement() });
  const mod = (id: string) => defineModule({ manifest: { id, label: id }, init(ctx) { ctx.defineTool({ name: `${id}_t`, description: "", handler: () => ({}) }); } });
  await host.load([mod("builtin"), mod("media")]);
  assert.deepEqual(registry.names(), ["builtin_t", "media_t"], "the environment does not narrow the modules");
});

test("the in-memory store follows the same rules", () => {
  const s = new MemoryModuleEnablement(["media"]);
  assert.equal(s.isEnabled("media"), false);
  assert.equal(s.isEnabled("builtin"), true);
  s.set("media", true);
  assert.equal(s.isEnabled("media"), true);
});
