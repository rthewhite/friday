import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openModuleDb, tablePrefix } from "../src/db.js";

/** node:sqlite rows have a null prototype. */
const plain = (rows: unknown[]) => rows.map((r) => ({ ...(r as object) }));

/** A file database with a core table and another module's table, opened by core's (unrestricted) connection. */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "friday-db-"));
  const file = join(dir, "friday.db");
  const core = new DatabaseSync(file);
  core.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE conversations (id TEXT PRIMARY KEY);
    CREATE TABLE config_values (key TEXT PRIMARY KEY);
    INSERT INTO conversations VALUES ('c1');
    INSERT INTO config_values VALUES ('k1');
    CREATE TABLE media_x__cache (k TEXT PRIMARY KEY);
  `);
  const opened: { close(): void }[] = [];
  return {
    file,
    core,
    open(id: string) {
      const m = openModuleDb(file, id);
      opened.push(m);
      return m;
    },
    cleanup() {
      for (const m of opened) m.close();
      core.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("prefix is the id with - mapped to _ plus a double underscore", () => {
  assert.equal(tablePrefix("brain"), "brain__");
  assert.equal(tablePrefix("media-x"), "media_x__");
  assert.equal(tablePrefix("a1-b2-c3"), "a1_b2_c3__");
});

test("ids whose prefix could overlap another module's are rejected", () => {
  assert.throws(() => tablePrefix("media--x"), /module media--x: .*"--" or a trailing "-"/);
  assert.throws(() => tablePrefix("media-"), /module media-: .*trailing "-"/);
  assert.throws(() => openModuleDb(":memory:", "bad-"), /trailing "-"/);
});

test("a module can create, write, read and drop its own tables", (t) => {
  const f = fixture();
  t.after(f.cleanup);
  const { db } = f.open("brain");
  db.exec("CREATE TABLE brain__pages (id INTEGER PRIMARY KEY, title TEXT NOT NULL UNIQUE)");
  db.exec("CREATE INDEX brain__pages_title ON brain__pages (title)");
  db.prepare("INSERT INTO brain__pages (title) VALUES (?)").run("home");
  db.prepare("UPDATE brain__pages SET title = ? WHERE id = 1").run("start");
  assert.deepEqual(plain(db.prepare("SELECT id, title FROM brain__pages").all()), [{ id: 1, title: "start" }]);
  db.prepare("DELETE FROM brain__pages").run();
  db.exec("CREATE VIEW brain__titles AS SELECT title FROM brain__pages");
  db.exec("CREATE TRIGGER brain__t AFTER INSERT ON brain__pages BEGIN SELECT 1; END");
  db.exec("ALTER TABLE brain__pages ADD COLUMN body TEXT");
  db.exec("ALTER TABLE brain__pages RENAME TO brain__docs");
  db.exec("DROP VIEW brain__titles; DROP TABLE brain__docs");
  // Names are case-insensitive in SQLite, and so is the prefix check.
  db.exec("CREATE TABLE BRAIN__Upper (a)");
});

test("core tables are refused for reads and writes, and stay unchanged", (t) => {
  const f = fixture();
  t.after(f.cleanup);
  const { db } = f.open("brain");
  assert.throws(() => db.prepare("SELECT * FROM conversations"), /module brain: database access refused: read conversations/);
  assert.throws(() => db.prepare("DELETE FROM config_values"), /module brain: database access refused: delete from config_values/);
  assert.throws(() => db.exec("DROP TABLE conversations"), /refused/);
  assert.throws(() => db.exec("CREATE INDEX brain__x ON conversations (id)"), /refused: create index/);
  assert.throws(() => db.exec("ALTER TABLE conversations ADD COLUMN x TEXT"), /refused: alter table conversations/);
  assert.throws(() => db.exec("CREATE TABLE pages (a)"), /refused: create table pages/);
  db.exec("CREATE TABLE brain__pages (a)");
  assert.throws(() => db.exec("ALTER TABLE brain__pages RENAME TO pages"), /refused: rename table to pages/);
  // A view or trigger may be created, but using it to reach a foreign table is refused.
  db.exec("CREATE VIEW brain__leak AS SELECT * FROM conversations");
  assert.throws(() => db.prepare("SELECT * FROM brain__leak"), /refused: read conversations/);
  assert.deepEqual(plain(f.core.prepare("SELECT * FROM conversations").all()), [{ id: "c1" }]);
  assert.deepEqual(plain(f.core.prepare("SELECT * FROM config_values").all()), [{ key: "k1" }]);
});

test("another module's prefixed table is refused", (t) => {
  const f = fixture();
  t.after(f.cleanup);
  const { db } = f.open("media");
  assert.throws(() => db.prepare("SELECT * FROM media_x__cache"), /module media: database access refused: read media_x__cache/);
  assert.throws(() => db.prepare("INSERT INTO media_x__cache VALUES ('a')"), /refused/);
});

test("pragmas and attached databases are refused; foreign keys stay enforced", (t) => {
  const f = fixture();
  t.after(f.cleanup);
  const { db } = f.open("brain");
  assert.throws(() => db.exec("PRAGMA foreign_keys = OFF"), /module brain: database access refused: pragma foreign_keys/);
  assert.throws(() => db.prepare("PRAGMA table_info(conversations)"), /refused: pragma table_info/);
  assert.throws(() => db.exec(`ATTACH '${f.file}' AS other`), /refused: attach/);
  db.exec(`
    CREATE TABLE brain__pages (id INTEGER PRIMARY KEY);
    CREATE TABLE brain__revisions (id INTEGER PRIMARY KEY, page INTEGER NOT NULL REFERENCES brain__pages (id));
  `);
  assert.throws(() => db.prepare("INSERT INTO brain__revisions (page) VALUES (42)").run(), /FOREIGN KEY constraint failed/);
});

test("an FTS5 table can be created and queried with MATCH", (t) => {
  const f = fixture();
  t.after(f.cleanup);
  const { db } = f.open("brain");
  db.exec("CREATE VIRTUAL TABLE brain__search USING fts5(title, body)");
  const insert = db.prepare("INSERT INTO brain__search (title, body) VALUES (?, ?)");
  insert.run("Kitchen", "The dishwasher is a Bosch");
  insert.run("Car", "Tyres changed in October");
  assert.deepEqual(plain(db.prepare("SELECT title FROM brain__search WHERE brain__search MATCH ?").all("bosch")), [{ title: "Kitchen" }]);
});

function pages() {
  const m = openModuleDb(":memory:", "brain");
  m.db.exec(`
    CREATE TABLE brain__pages (id INTEGER PRIMARY KEY, title TEXT NOT NULL);
    CREATE TABLE brain__revisions (id INTEGER PRIMARY KEY, page INTEGER NOT NULL REFERENCES brain__pages (id), body TEXT NOT NULL);
  `);
  const count = (table: string) => (m.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
  return { m, db: m.db, count };
}

test("transaction commits when the body returns and passes its result through", () => {
  const { db, count } = pages();
  const id = db.transaction(() => {
    const { lastInsertRowid } = db.prepare("INSERT INTO brain__pages (title) VALUES ('a')").run();
    db.prepare("INSERT INTO brain__revisions (page, body) VALUES (?, 'v1')").run(lastInsertRowid);
    return Number(lastInsertRowid);
  });
  assert.equal(id, 1);
  assert.equal(count("brain__pages"), 1);
  assert.equal(count("brain__revisions"), 1);
});

test("transaction rolls back every row and rethrows when the body throws", () => {
  const { db, count } = pages();
  assert.throws(() => db.transaction(() => {
    db.prepare("INSERT INTO brain__pages (title) VALUES ('a')").run();
    db.prepare("INSERT INTO brain__revisions (page, body) VALUES (1, NULL)").run();
  }), /NOT NULL constraint failed/);
  assert.equal(count("brain__pages"), 0);
  assert.equal(count("brain__revisions"), 0);
});

test("an async transaction body is rolled back and throws", async () => {
  const { db, count } = pages();
  assert.throws(() => db.transaction(async () => {
    db.prepare("INSERT INTO brain__pages (title) VALUES ('a')").run();
    throw new Error("later");
  }), /module brain: transaction bodies must be synchronous/);
  await new Promise((r) => setImmediate(r));
  assert.equal(count("brain__pages"), 0);
  // The connection is usable again afterwards.
  db.transaction(() => db.prepare("INSERT INTO brain__pages (title) VALUES ('b')").run());
  assert.equal(count("brain__pages"), 1);
});

test("an inner transaction that throws is undone without ending the outer one", () => {
  const { db, count } = pages();
  db.transaction(() => {
    db.prepare("INSERT INTO brain__pages (title) VALUES ('outer')").run();
    try {
      db.transaction(() => {
        db.prepare("INSERT INTO brain__pages (title) VALUES ('inner')").run();
        throw new Error("inner failed");
      });
    } catch {
      // handled by the outer body
    }
    db.transaction(() => db.prepare("INSERT INTO brain__revisions (page, body) VALUES (1, 'kept')").run());
  });
  assert.deepEqual(plain(db.prepare("SELECT title FROM brain__pages").all()), [{ title: "outer" }]);
  assert.equal(count("brain__revisions"), 1);
});
