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
  assert.equal(schemaVersion(db), Math.max(...migrations.map((m) => m.version)));
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[]).map((t) => t.name);
  const search = ["conversation_search", "conversation_search_config", "conversation_search_data", "conversation_search_docsize", "conversation_search_idx"];
  assert.deepEqual(tables, ["alerts", "config_values", "conversation_entries", ...search, "conversations", "device_attempts", "devices", "job_runs", "job_state", "mcp_server_headers", "mcp_servers", "module_keys", "module_kv", "schema_version"]);
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

test("migration 3 upgrades a version-2 database with the job tables", () => {
  const db = new DatabaseSync(":memory:");
  migrate(db, migrations.filter((m) => m.version <= 2), quiet);
  assert.equal(schemaVersion(db), 2);
  db.prepare("INSERT INTO module_kv VALUES ('m', 'k', '1', 'now')").run();
  assert.equal(migrate(db, migrations, quiet), migrations.filter((m) => m.version > 2).length);
  assert.ok(schemaVersion(db) >= 3);
  const names = (db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'job_%' ORDER BY name").all() as { name: string }[]).map((t) => t.name);
  assert.deepEqual(names, ["job_runs", "job_runs_job_started", "job_state"]);
  assert.equal((db.prepare("SELECT count(*) AS n FROM module_kv").get() as { n: number }).n, 1, "existing data survives");
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

test("an existing database gains the conversation tables, their indexes and the cascading foreign key", async () => {
  const dir = await mkdtemp(join(tmpdir(), "friday-db-"));
  const old = new DatabaseSync(join(dir, "friday.db"));
  migrate(old, migrations.filter((m) => m.version < 4), quiet);
  old.prepare("INSERT INTO module_kv (module_id, key, value_json, updated_at) VALUES ('a', 'k', '1', 'now')").run();
  assert.ok(schemaVersion(old) < 4);
  old.close();

  const db = openDatabase(dir, "friday.db", quiet);
  assert.equal(schemaVersion(db), Math.max(...migrations.map((m) => m.version)));
  assert.equal((db.prepare("SELECT value_json FROM module_kv").get() as { value_json: string }).value_json, "1");
  const indexes = (db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='conversations' AND sql IS NOT NULL ORDER BY name").all() as { name: string }[]).map((i) => i.name);
  assert.deepEqual(indexes, ["conversations_last_activity", "conversations_quiet"]);
  db.prepare("INSERT INTO conversations (id, channel, started_at, last_activity_at) VALUES ('c', 'voice', 'x', 'x')").run();
  db.prepare("INSERT INTO conversation_entries (conversation_id, seq, kind, text, at) VALUES ('c', 1, 'user', 'hi', 'x')").run();
  assert.throws(() => db.prepare("INSERT INTO conversation_entries (conversation_id, seq, kind, at) VALUES ('nope', 1, 'user', 'x')").run(), /FOREIGN KEY/);
  db.prepare("DELETE FROM conversations WHERE id = 'c'").run();
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM conversation_entries").get() as { n: number }).n, 0);
  db.close();
});

test("a version-4 database gains the MCP server tables and headers cascade with their server", async () => {
  const dir = await mkdtemp(join(tmpdir(), "friday-db-"));
  const old = new DatabaseSync(join(dir, "friday.db"));
  migrate(old, migrations.filter((m) => m.version <= 4), quiet);
  old.close();

  const db = openDatabase(dir, "friday.db", quiet);
  assert.equal(schemaVersion(db), Math.max(...migrations.map((m) => m.version)));
  db.prepare("INSERT INTO mcp_servers (name, url, created_at, updated_at) VALUES ('home', 'http://x', 'now', 'now')").run();
  db.prepare("INSERT INTO mcp_server_headers (server, name, position, secret, plaintext) VALUES ('home', 'X-A', 0, 0, 'a')").run();
  assert.throws(() => db.prepare("INSERT INTO mcp_server_headers (server, name, position, secret, plaintext) VALUES ('nope', 'X-A', 0, 0, 'a')").run(), /FOREIGN KEY/);
  db.prepare("DELETE FROM mcp_servers WHERE name = 'home'").run();
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM mcp_server_headers").get() as { n: number }).n, 0);
  db.close();
});

/** Conversation ids whose indexed entries match `word`, as the store's search query does. */
const matching = (db: DatabaseSync, word: string) =>
  (db.prepare("SELECT DISTINCT e.conversation_id AS id FROM conversation_search s JOIN conversation_entries e ON e.id = s.rowid WHERE conversation_search MATCH ? ORDER BY id").all(`"${word}"`) as { id: string }[]).map((r) => r.id);

test("a version-5 database gains the search index over its existing entries: text, tool names and argument values", async () => {
  const dir = await mkdtemp(join(tmpdir(), "friday-db-"));
  const old = new DatabaseSync(join(dir, "friday.db"));
  old.exec("PRAGMA foreign_keys = ON");
  migrate(old, migrations.filter((m) => m.version <= 5), quiet);
  old.exec(`
    INSERT INTO conversations (id, channel, started_at, last_activity_at) VALUES ('c1', 'voice', 't', 't'), ('c2', 'chat', 't', 't'), ('c3', 'voice', 't', 't');
    INSERT INTO conversation_entries (conversation_id, seq, kind, input, text, at) VALUES ('c1', 1, 'user', 'speech', 'Is the boiler service booked?', 't');
    INSERT INTO conversation_entries (conversation_id, seq, kind, tool_name, tool_args, tool_result, at)
      VALUES ('c2', 1, 'tool', 'play_on_apple_tv', '{"title":"Dune","options":{"subtitles":["Nederlands"],"episode":4}}', '{"up_next":"Arrival"}', 't');
    INSERT INTO conversation_entries (conversation_id, seq, kind, text, at) VALUES ('c2', 2, 'assistant', 'Playing it in the café.', 't');
    INSERT INTO conversation_entries (conversation_id, seq, kind, tool_name, tool_args, truncated, at) VALUES ('c3', 1, 'tool', 'note', '{"text":"a long letter about the gutt', 1, 't');
  `);
  old.close();

  const db = openDatabase(dir, "friday.db", quiet);
  assert.equal(schemaVersion(db), Math.max(...migrations.map((m) => m.version)));
  assert.deepEqual(matching(db, "boiler"), ["c1"]);
  assert.deepEqual(matching(db, "dune"), ["c2"], "argument values are indexed");
  assert.deepEqual(matching(db, "nederlands"), ["c2"], "nested values too");
  assert.deepEqual(matching(db, "play_on_apple"), ["c2"], "and the tool name");
  assert.deepEqual(matching(db, "title"), [], "argument keys are not");
  assert.deepEqual(matching(db, "subtitles"), []);
  assert.deepEqual(matching(db, "Arrival"), [], "tool results are not");
  assert.deepEqual(matching(db, "cafe"), ["c2"], "accents are ignored");
  assert.deepEqual(matching(db, "gutt"), ["c3"], "arguments cut short are indexed as text");
  // The entries kept their order and their constraints.
  const rows = db.prepare("SELECT conversation_id, seq, kind FROM conversation_entries ORDER BY id").all().map((r) => ({ ...r }));
  assert.deepEqual(rows, [
    { conversation_id: "c1", seq: 1, kind: "user" },
    { conversation_id: "c2", seq: 1, kind: "tool" },
    { conversation_id: "c2", seq: 2, kind: "assistant" },
    { conversation_id: "c3", seq: 1, kind: "tool" },
  ]);
  assert.throws(() => db.exec("INSERT INTO conversation_entries (conversation_id, seq, kind, at) VALUES ('c1', 1, 'user', 't')"), /UNIQUE/);
  assert.throws(() => db.exec("INSERT INTO conversation_entries (conversation_id, seq, kind, at) VALUES ('nope', 1, 'user', 't')"), /FOREIGN KEY/);
  db.close();
});

test("the search index is keyed by an explicit id and survives VACUUM, which may renumber implicit rowids", async () => {
  const db = openDatabase(await mkdtemp(join(tmpdir(), "friday-db-")), "friday.db", quiet);
  // SQLite only promises stable rowids for an INTEGER PRIMARY KEY, so the index must not rely on implicit ones.
  const pk = (db.prepare("PRAGMA table_info(conversation_entries)").all() as { name: string; type: string; pk: number }[]).filter((c) => c.pk);
  assert.deepEqual(pk.map((c) => [c.name, c.type]), [["id", "INTEGER"]]);
  const triggers = (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'conversation_entries'").all() as { sql: string }[]).map((t) => t.sql);
  assert.equal(triggers.length, 3);
  assert.ok(triggers.every((sql) => !/\browid\s*=\s*(old|new)\.rowid|\((new|old)\.rowid/.test(sql)), "triggers key on the id column");
  db.exec("INSERT INTO conversations (id, channel, started_at, last_activity_at) VALUES ('a', 'voice', 't', 't'), ('b', 'voice', 't', 't'), ('c', 'voice', 't', 't')");
  const add = db.prepare("INSERT INTO conversation_entries (conversation_id, seq, kind, input, text, at) VALUES (?, ?, 'user', 'speech', ?, 't')");
  add.run("a", 1, "about the boiler");
  add.run("b", 1, "about the heater");
  add.run("c", 1, "about the garden");
  db.exec("DELETE FROM conversations WHERE id = 'a'");
  db.exec("VACUUM");
  assert.deepEqual(matching(db, "heater"), ["b"]);
  assert.deepEqual(matching(db, "garden"), ["c"]);
  db.exec("DELETE FROM conversations WHERE id = 'b'");
  assert.deepEqual(matching(db, "heater"), []);
  assert.deepEqual(matching(db, "garden"), ["c"], "deleting one entry removed only its own index row");
  db.close();
});

test("the search index follows new entries and cascaded deletes", async () => {
  const db = openDatabase(await mkdtemp(join(tmpdir(), "friday-db-")), "friday.db", quiet);
  db.exec(`
    INSERT INTO conversations (id, channel, started_at, last_activity_at) VALUES ('c1', 'voice', 't', 't'), ('c2', 'voice', 't', 't');
    INSERT INTO conversation_entries (conversation_id, seq, kind, input, text, at) VALUES ('c1', 1, 'user', 'speech', 'the boilers', 't'), ('c2', 1, 'user', 'speech', 'boiler key', 't');
  `);
  assert.deepEqual(matching(db, "boiler"), ["c1", "c2"]);
  db.exec("DELETE FROM conversations WHERE id = 'c1'");
  assert.deepEqual(matching(db, "boiler"), ["c2"]);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM conversation_search WHERE conversation_search MATCH '\"boilers\"'").get() as { n: number }).n, 0);
  db.close();
});

test("a version-6 database gains the empty device tables and keeps its conversations", async () => {
  const dir = await mkdtemp(join(tmpdir(), "friday-db-"));
  const old = new DatabaseSync(join(dir, "friday.db"));
  old.exec("PRAGMA foreign_keys = ON");
  migrate(old, migrations.filter((m) => m.version <= 6), quiet);
  old.exec(`
    INSERT INTO conversations (id, channel, device, started_at, last_activity_at) VALUES ('c1', 'voice', 'friday-voice', 't', 't');
    INSERT INTO conversation_entries (conversation_id, seq, kind, input, text, at) VALUES ('c1', 1, 'user', 'speech', 'Turn on the lights', 't');
  `);
  old.close();

  const db = openDatabase(dir, "friday.db", quiet);
  assert.equal(schemaVersion(db), Math.max(...migrations.map((m) => m.version)));
  assert.deepEqual({ ...db.prepare("SELECT COUNT(*) AS n FROM devices").get() }, { n: 0 });
  assert.deepEqual({ ...db.prepare("SELECT COUNT(*) AS n FROM device_attempts").get() }, { n: 0 });
  assert.deepEqual({ ...db.prepare("SELECT id, device FROM conversations").get() }, { id: "c1", device: "friday-voice" });
  assert.deepEqual(matching(db, "lights"), ["c1"], "the search index is untouched");
  db.close();
});

test("a version-7 database gains the empty alerts table and keeps its devices", async () => {
  const dir = await mkdtemp(join(tmpdir(), "friday-db-"));
  const old = new DatabaseSync(join(dir, "friday.db"));
  migrate(old, migrations.filter((m) => m.version <= 7), quiet);
  old.exec("INSERT INTO devices (id, label, key_hash, created_at) VALUES ('friday-kitchen', 'Kitchen', 'h', 't')");
  old.close();

  const db = openDatabase(dir, "friday.db", quiet);
  assert.equal(schemaVersion(db), 8);
  assert.deepEqual({ ...db.prepare("SELECT COUNT(*) AS n FROM alerts").get() }, { n: 0 });
  const indexes = (db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='alerts' AND sql IS NOT NULL ORDER BY name").all() as { name: string }[]).map((i) => i.name);
  assert.deepEqual(indexes, ["alerts_target_state"]);
  assert.deepEqual({ ...db.prepare("SELECT id FROM devices").get() }, { id: "friday-kitchen" });
  db.close();
});
