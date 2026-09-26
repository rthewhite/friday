import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { migrate, migrations, openDatabase, schemaVersion } from "../src/storage/db.js";
import { SqliteModuleStorage } from "../src/storage/module-kv.js";

const quiet = { log() {} };

test("fresh start creates the database and applies all migrations", async () => {
  const dir = await mkdtemp(join(tmpdir(), "friday-db-"));
  const db = openDatabase(join(dir, "nested", "data"), "friday.db", quiet);
  assert.equal(schemaVersion(db), migrations.at(-1)!.version);
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[]).map((t) => t.name);
  assert.deepEqual(tables, ["config_values", "module_keys", "module_kv", "schema_version"]);
  db.close();
  // reopening applies nothing
  const again = openDatabase(join(dir, "nested", "data"), "friday.db", quiet);
  assert.equal(migrate(again, migrations, quiet), 0);
  again.close();
});

test("incremental upgrade runs only newer migrations and a failure aborts by name", () => {
  const db = new DatabaseSync(":memory:");
  const v1 = { version: 1, name: "one", sql: "CREATE TABLE a (x)" };
  const v2 = { version: 2, name: "two", sql: "CREATE TABLE b (x)" };
  assert.equal(migrate(db, [v1], quiet), 1);
  assert.equal(migrate(db, [v1, v2], quiet), 1);
  assert.equal(schemaVersion(db), 2);
  assert.throws(() => migrate(db, [v1, v2, { version: 3, name: "broken", sql: "CREATE TABLE b (x)" }], quiet), /migration 3 \(broken\) failed/);
  assert.equal(schemaVersion(db), 2);
});

test("module storage isolates namespaces and round-trips JSON", async () => {
  const dir = await mkdtemp(join(tmpdir(), "friday-db-"));
  const db = openDatabase(dir, "friday.db", quiet);
  const a = new SqliteModuleStorage(db, "a"), b = new SqliteModuleStorage(db, "b");
  await a.set("last", { n: 1 });
  await b.set("last", "other");
  await a.set("lap:1", 90.1);
  await a.set("lap:2", 91.2);
  assert.deepEqual(await a.get("last"), { n: 1 });
  assert.equal(await b.get("last"), "other");
  assert.deepEqual(await a.list(), ["lap:1", "lap:2", "last"]);
  assert.deepEqual(await a.list("lap:"), ["lap:1", "lap:2"]);
  assert.equal(await a.delete("lap:1"), true);
  assert.equal(await a.delete("lap:1"), false);
  db.close();
  const reopened = new SqliteModuleStorage(openDatabase(dir, "friday.db", quiet), "a");
  assert.deepEqual(await reopened.get("last"), { n: 1 });
  assert.equal(await reopened.get("missing"), undefined);
});
