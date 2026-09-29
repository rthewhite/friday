import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openModuleDb, tablePrefix, type ModuleDb } from "../src/db.js";
import { defineModule, Type } from "../src/index.js";
import { createTestHost } from "../src/test.js";

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

test("a rename out of the prefix is refused however the SQL is written", (t) => {
  const f = fixture();
  t.after(f.cleanup);
  const { db } = f.open("brain");
  db.exec("CREATE TABLE brain__pages (a)");
  for (const sql of [
    "ALTER TABLE brain__pages RENAME /* sneaky */ TO pages",
    "ALTER TABLE brain__pages RENAME -- sneaky\n TO pages",
    "ALTER TABLE brain__pages RENAME TO/**/pages",
    'ALTER TABLE brain__pages RENAME TO "media__notes"',
    "ALTER TABLE brain__pages RENAME TO [conversations2]",
    "ALTER TABLE brain__pages RENAME TO évil",
  ]) assert.throws(() => db.exec(sql), /module brain: database access refused: rename table to /, sql);
  db.exec("ALTER TABLE brain__pages RENAME /* fine */ TO brain__docs");
  // A column rename is not a table rename.
  db.exec("ALTER TABLE brain__docs RENAME COLUMN a TO pages");
  assert.deepEqual(f.core.prepare("SELECT name FROM sqlite_master WHERE name NOT IN ('conversations', 'config_values', 'media_x__cache') AND name NOT LIKE 'sqlite%' ORDER BY name").all().map((r) => r.name), ["brain__docs"]);
});

test("SQLite's shared bookkeeping tables are read-only to modules, except as a side effect of their own DDL", (t) => {
  const f = fixture();
  t.after(f.cleanup);
  f.core.exec("CREATE TABLE secrets (id INTEGER PRIMARY KEY AUTOINCREMENT, v); INSERT INTO secrets (v) VALUES (1); CREATE INDEX secrets_v ON secrets (v); ANALYZE");
  const { db } = f.open("brain");
  assert.throws(() => db.exec("UPDATE sqlite_sequence SET seq = 999 WHERE name = 'secrets'"), /refused: update sqlite_sequence/);
  assert.throws(() => db.exec("DELETE FROM sqlite_sequence"), /refused: delete from sqlite_sequence/);
  assert.throws(() => db.exec("INSERT INTO sqlite_stat1 VALUES ('secrets', NULL, '1')"), /refused/);
  assert.equal(f.core.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'secrets'").get()?.seq, 1);
  // Its own AUTOINCREMENT tables and statistics still work through DDL.
  db.exec("CREATE TABLE brain__a (id INTEGER PRIMARY KEY AUTOINCREMENT, x); CREATE INDEX brain__a_x ON brain__a (x); INSERT INTO brain__a (x) VALUES (1), (2)");
  db.exec("ANALYZE brain__a");
  db.exec("ALTER TABLE brain__a RENAME TO brain__b");
  db.exec("DROP TABLE brain__b");
  assert.equal(f.core.prepare("SELECT count(*) AS n FROM sqlite_sequence WHERE name LIKE 'brain%'").get()?.n, 0);
  // Reading the schema stays allowed.
  assert.ok(db.prepare("SELECT name FROM sqlite_master").all().length > 0);
});

test("transaction statements are refused outside transaction()", () => {
  const { db, count } = pages();
  for (const sql of ["BEGIN", "BEGIN IMMEDIATE", "COMMIT", "ROLLBACK", "SAVEPOINT x", "RELEASE x"]) {
    assert.throws(() => db.exec(sql), /module brain: database access refused: .*statement \(use ctx\.db\.transaction\)/, sql);
  }
  assert.throws(() => db.transaction(() => db.exec("COMMIT")), /refused/);
  db.transaction(() => db.prepare("INSERT INTO brain__pages (title) VALUES ('ok')").run());
  assert.equal(count("brain__pages"), 1);
});

test("renameTargets ignores comments but keeps quoted names", async () => {
  const { renameTargets } = await import("../src/db.js");
  assert.deepEqual(renameTargets("ALTER TABLE a RENAME /* x */ TO b; ALTER TABLE c RENAME TO \"d \"\"e\"\"\""), ["b", 'd "e"']);
  assert.deepEqual(renameTargets("SELECT 1 -- RENAME TO y\n/* RENAME TO z */"), []);
  // Text in string literals is matched: conservative, it can only refuse more.
  assert.deepEqual(renameTargets("SELECT '/* RENAME TO x */'"), ["x"]);
  assert.deepEqual(renameTargets("ALTER TABLE a RENAME COLUMN x TO y"), []);
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

const pagesV1 = { version: 1, name: "pages", up: "CREATE TABLE brain__pages (id INTEGER PRIMARY KEY, title TEXT NOT NULL)" };
const revisionsV2 = { version: 2, name: "revisions", up: "CREATE TABLE brain__revisions (id INTEGER PRIMARY KEY, page INTEGER NOT NULL REFERENCES brain__pages (id))" };
const tagsV3 = { version: 3, name: "tags", up: (db: ModuleDb) => db.exec("CREATE TABLE brain__tags (name TEXT PRIMARY KEY)") };
const recorded = (core: DatabaseSync, id = "brain") => !core.prepare("SELECT 1 FROM sqlite_master WHERE name = 'module_schema'").get() ? undefined : (core.prepare("SELECT version FROM module_schema WHERE module_id = ?").get(id) as { version: number } | undefined)?.version;
const tables = (core: DatabaseSync) => (core.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'brain\\_\\_%' ESCAPE '\\' ORDER BY name").all() as { name: string }[]).map((r) => r.name);

test("first start runs every migration in version order and records the latest", (t) => {
  const f = fixture();
  t.after(f.cleanup);
  const lines: string[] = [];
  const m = f.open("brain");
  // Declared out of order on purpose.
  assert.deepEqual(m.migrate([revisionsV2, pagesV1], { log: (...a) => lines.push(a.join(" ")), warn() {}, error() {} }), [1, 2]);
  assert.equal(recorded(f.core), 2);
  assert.equal(m.version(), 2);
  assert.deepEqual(tables(f.core), ["brain__pages", "brain__revisions"]);
  assert.deepEqual(lines, ['migration 1 "pages" applied', 'migration 2 "revisions" applied']);
  const row = f.core.prepare("SELECT updated_at FROM module_schema WHERE module_id = 'brain'").get() as { updated_at: string };
  assert.ok(!Number.isNaN(Date.parse(row.updated_at)));
});

test("an upgrade runs only the pending migrations, and nothing pending runs nothing", (t) => {
  const f = fixture();
  t.after(f.cleanup);
  f.open("brain").migrate([pagesV1]);
  const again = f.open("brain");
  assert.deepEqual(again.migrate([pagesV1, revisionsV2, tagsV3]), [2, 3]);
  assert.equal(recorded(f.core), 3);
  assert.deepEqual(again.migrate([pagesV1, revisionsV2, tagsV3]), []);
  assert.deepEqual(tables(f.core), ["brain__pages", "brain__revisions", "brain__tags"]);
});

test("each module has its own recorded version", (t) => {
  const f = fixture();
  t.after(f.cleanup);
  f.open("brain").migrate([pagesV1, revisionsV2]);
  f.open("media-x").migrate([{ version: 1, name: "cache2", up: "CREATE TABLE media_x__cache2 (k TEXT)" }]);
  assert.equal(recorded(f.core, "brain"), 2);
  assert.equal(recorded(f.core, "media-x"), 1);
});

test("an invalid list fails before any migration runs", (t) => {
  const f = fixture();
  t.after(f.cleanup);
  const m = f.open("brain");
  assert.throws(() => m.migrate([pagesV1, revisionsV2, { ...tagsV3, version: 2 }]), /module brain: duplicate migration version 2/);
  assert.throws(() => m.migrate([{ ...pagesV1, version: 0 }]), /module brain: migration version 0 is not a positive integer/);
  assert.throws(() => m.migrate([{ ...pagesV1, version: 1.5 }]), /not a positive integer/);
  assert.throws(() => m.migrate([{ ...pagesV1, name: " " }]), /module brain: migration 1 has no name/);
  assert.throws(() => m.migrate([{ ...pagesV1, up: undefined as unknown as string }]), /migration 1 "pages" has no up/);
  assert.deepEqual(tables(f.core), []);
  assert.equal(recorded(f.core), undefined);
});

test("a broken migration is rolled back with its version; earlier ones stay applied", (t) => {
  const f = fixture();
  t.after(f.cleanup);
  const m = f.open("brain");
  const broken = { version: 2, name: "revisions", up: "CREATE TABLE brain__revisions (id INTEGER PRIMARY KEY); CREAT TABLE brain__oops (a)" };
  assert.throws(() => m.migrate([pagesV1, broken, tagsV3]), /module brain: migration 2 "revisions" failed: .*syntax error/);
  assert.equal(recorded(f.core), 1);
  assert.deepEqual(tables(f.core), ["brain__pages"]);
  assert.throws(() => m.migrate([pagesV1, { ...tagsV3, version: 2, up: () => { throw new Error("boom"); } }]), /migration 2 "tags" failed: boom/);
  assert.equal(recorded(f.core), 1);
});

test("an unprefixed CREATE TABLE in a migration fails it", (t) => {
  const f = fixture();
  t.after(f.cleanup);
  const m = f.open("brain");
  assert.throws(() => m.migrate([{ version: 1, name: "pages", up: "CREATE TABLE pages (a)" }]), /module brain: migration 1 "pages" failed: module brain: database access refused: create table pages/);
  assert.equal(recorded(f.core), undefined);
  assert.equal(f.core.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'pages'").get()?.n, 0);
});

test("module_schema is not reachable through ctx.db or a migration", (t) => {
  const f = fixture();
  t.after(f.cleanup);
  const m = f.open("brain");
  m.migrate([pagesV1]);
  assert.throws(() => m.db.prepare("SELECT * FROM module_schema"), /refused: read module_schema/);
  assert.throws(() => m.db.exec("UPDATE module_schema SET version = 99"), /refused/);
  assert.throws(() => m.migrate([pagesV1, { version: 2, name: "sneaky", up: "DELETE FROM module_schema" }]), /migration 2 "sneaky" failed: .*refused: delete from module_schema/);
  assert.equal(recorded(f.core), 1);
});

test("a schema newer than the module's migrations fails and touches nothing", (t) => {
  const f = fixture();
  t.after(f.cleanup);
  f.open("brain").migrate([pagesV1, revisionsV2, tagsV3]);
  f.core.exec("INSERT INTO brain__pages (title) VALUES ('kept')");
  const older = f.open("brain");
  assert.throws(() => older.migrate([pagesV1, revisionsV2]), { message: "database schema v3 is newer than module brain's migrations (v2)" });
  assert.equal(recorded(f.core), 3);
  assert.deepEqual(tables(f.core), ["brain__pages", "brain__revisions", "brain__tags"]);
  assert.equal(f.core.prepare("SELECT count(*) AS n FROM brain__pages").get()?.n, 1);
});

test("a migration may not manage its own transaction", (t) => {
  const f = fixture();
  t.after(f.cleanup);
  const m = f.open("brain");
  assert.throws(() => m.migrate([{ version: 1, name: "tx", up: "BEGIN; CREATE TABLE brain__a (x); COMMIT" }]), /migration 1 "tx" failed: .*refused: begin statement/);
  assert.equal(recorded(f.core), undefined);
  assert.deepEqual(tables(f.core), []);
});

test("an async migration function fails the migration", (t) => {
  const f = fixture();
  t.after(f.cleanup);
  const m = f.open("brain");
  const up = (async (db: ModuleDb) => db.exec("CREATE TABLE brain__a (x)")) as unknown as (db: ModuleDb) => void;
  assert.throws(() => m.migrate([{ version: 1, name: "async", up }]), /migration 1 "async" failed: .*must be synchronous/);
  assert.equal(recorded(f.core), undefined);
});

// The example from README.md ("Tables" and "Testing a module"), verbatim.
export const notes = defineModule({
  manifest: { id: "notes", label: "Notes" },
  migrations: [
    { version: 1, name: "notes", up: "CREATE TABLE notes__notes (id INTEGER PRIMARY KEY, text TEXT NOT NULL, created_at TEXT NOT NULL)" },
    {
      version: 2,
      name: "tags",
      up: (db) => {
        db.exec("CREATE TABLE notes__tags (note INTEGER NOT NULL REFERENCES notes__notes (id) ON DELETE CASCADE, tag TEXT NOT NULL, PRIMARY KEY (note, tag))");
        db.exec("CREATE INDEX notes__tags_tag ON notes__tags (tag)");
      },
    },
  ],
  init(ctx) {
    const insertNote = ctx.db.prepare("INSERT INTO notes__notes (text, created_at) VALUES (?, ?)");
    const insertTag = ctx.db.prepare("INSERT INTO notes__tags (note, tag) VALUES (?, ?)");
    const byTag = ctx.db.prepare("SELECT n.id, n.text FROM notes__notes n JOIN notes__tags t ON t.note = n.id WHERE t.tag = ? ORDER BY n.id");

    ctx.defineTool<{ text: string; tags?: string[] }>({
      name: "add_note",
      description: "Saves a note with optional tags",
      parameters: {
        type: Type.OBJECT,
        properties: { text: { type: Type.STRING }, tags: { type: Type.ARRAY, items: { type: Type.STRING } } },
        required: ["text"],
      },
      // The note and its tags are written together or not at all.
      handler: ({ text, tags = [] }) =>
        ctx.db.transaction(() => {
          const id = Number(insertNote.run(text, new Date().toISOString()).lastInsertRowid);
          for (const tag of tags) insertTag.run(id, tag);
          return { id };
        }),
    });
    ctx.defineTool<{ tag: string }>({
      name: "notes_by_tag",
      description: "Notes with a tag",
      parameters: { type: Type.OBJECT, properties: { tag: { type: Type.STRING } }, required: ["tag"] },
      handler: ({ tag }) => ({ notes: byTag.all(tag) }),
    });

    // Tell Friday the notes exist (see Prompt context).
    const count = ctx.db.prepare("SELECT count(*) AS n FROM notes__notes");
    ctx.prompt.addContext(({ channel }) => {
      const { n } = count.get() as { n: number };
      if (!n) return undefined;
      return channel === "voice"
        ? `## Notes\nThe user has ${n} notes; use notes_by_tag to look them up.`
        : `## Notes\nThe user has ${n} saved notes. Use notes_by_tag to find them and cite the note ids.`;
    });
  },
});

test("the README notes example migrates, writes atomically and renders its prompt context", async () => {
  const h = await createTestHost(notes);
  h.db.prepare("INSERT INTO notes__notes (text, created_at) VALUES (?, ?)").run("Buy milk", "2026-01-01T00:00:00Z");
  await h.call("add_note", { text: "Call the plumber", tags: ["house"] });
  assert.deepEqual(h.db.prepare("SELECT tag FROM notes__tags").all().map((r) => r.tag), ["house"]);
  assert.equal(h.promptContext("voice"), "## Notes\nThe user has 2 notes; use notes_by_tag to look them up.");
  // Beyond the README: the chat variant, the query tool, and a failed tag insert rolling back its note.
  assert.equal(h.promptContext("chat"), "## Notes\nThe user has 2 saved notes. Use notes_by_tag to find them and cite the note ids.");
  assert.deepEqual(plain((await h.call("notes_by_tag", { tag: "house" })).result.notes as unknown[]), [{ id: 2, text: "Call the plumber" }]);
  assert.match(String((await h.call("add_note", { text: "dup", tags: ["a", "a"] })).result.error), /UNIQUE constraint failed/);
  assert.equal(h.db.prepare("SELECT count(*) AS n FROM notes__notes").get()?.n, 2);
});
