import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestHost } from "@friday/sdk/test";
import { openModuleDb } from "@friday/sdk/db";
import brain from "../src/index.js";
import { migrations } from "../src/schema.js";

const plain = (r: unknown[]) => r.map((x) => ({ ...(x as object) }));

test("after the first start the brain holds an empty profile with empty instructions and an empty subject page Me", async () => {
  const h = await createTestHost(brain);
  const pages = plain(h.db.prepare("SELECT id, name, type, body, is_profile, instructions, subject_id, deleted_at FROM brain__pages ORDER BY is_profile DESC").all());
  const subject = pages[1] as { id: string };
  assert.deepEqual(pages, [
    { id: "profile", name: "Profile", type: "other", body: "", is_profile: 1, instructions: "", subject_id: subject.id, deleted_at: null },
    { id: subject.id, name: "Me", type: "person", body: "", is_profile: 0, instructions: null, subject_id: null, deleted_at: null },
  ]);
  const revisions = plain(h.db.prepare("SELECT page_id, author, body, instructions, note FROM brain__revisions ORDER BY id").all());
  assert.deepEqual(revisions, [
    { page_id: "profile", author: "system", body: "", instructions: "", note: "created" },
    { page_id: subject.id, author: "system", body: "", instructions: null, note: "moved from the profile" },
  ]);
  assert.deepEqual(plain(h.db.prepare("SELECT key, page_id FROM brain__names ORDER BY key").all()), [{ key: "me", page_id: subject.id }, { key: "profile", page_id: "profile" }]);
  // The brain from before users is the owner's (the test host's owner), and a second profile for them is refused by the database itself.
  assert.deepEqual(plain(h.db.prepare("SELECT DISTINCT user_id FROM brain__pages").all()), [{ user_id: "test-user" }]);
  assert.throws(() => h.db.prepare("INSERT INTO brain__pages (id, user_id, name, type, is_profile, created_at, updated_at) VALUES ('x', 'test-user', 'Other', 'other', 1, '', '')").run(), /UNIQUE constraint failed/);
  await h.dispose();
});

test("a second start on the same data runs no migration and keeps the profile and its subject", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "brain-schema-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "friday.db");
  const first = openModuleDb(file, "brain");
  assert.deepEqual(first.migrate(migrations), [1, 2, 3, 4, 5]);
  first.close();
  const second = openModuleDb(file, "brain");
  assert.deepEqual(second.migrate(migrations), []);
  assert.equal(second.db.prepare("SELECT count(*) AS n FROM brain__pages").get()?.n, 2);
  second.close();
});

/** A brain at version 2 with the given setup, then upgraded to 3. */
function upgrade(setup: (db: ReturnType<typeof openModuleDb>["db"]) => void) {
  const d = openModuleDb(":memory:", "brain");
  d.migrate(migrations.slice(0, 2));
  setup(d.db);
  assert.deepEqual(d.migrate(migrations.slice(0, 3)), [3]);
  const subject = d.db.prepare("SELECT p.id, p.name, p.type, p.body FROM brain__pages p JOIN brain__pages pr ON pr.subject_id = p.id WHERE pr.id = 'profile'").get() as { id: string; name: string; type: string; body: string };
  return { db: d.db, subject, close: () => d.close() };
}

const addPage = (db: ReturnType<typeof openModuleDb>["db"], id: string, name: string) => {
  db.prepare("INSERT INTO brain__pages (id, name, type, created_at, updated_at, revision_id) VALUES (?, ?, 'other', '', '', 0)").run(id, name);
  db.prepare("INSERT INTO brain__names (key, page_id, kind) VALUES (?, ?, 'name')").run(name.toLowerCase(), id);
};

test("upgrade: the profile's body moves to a new subject page Me, and stays as the summary until one is generated", (t) => {
  const { db, subject, close } = upgrade((db) => db.prepare("UPDATE brain__pages SET body = 'Has two cats: Oreo and Sylvester' WHERE id = 'profile'").run());
  t.after(close);
  assert.deepEqual({ ...subject, id: undefined }, { id: undefined, name: "Me", type: "person", body: "Has two cats: Oreo and Sylvester" });
  assert.deepEqual(plain(db.prepare("SELECT author, body, note FROM brain__revisions WHERE page_id = ?").all(subject.id)), [{ author: "system", body: "Has two cats: Oreo and Sylvester", note: "moved from the profile" }]);
  assert.deepEqual({ ...(db.prepare("SELECT body, instructions FROM brain__pages WHERE id = 'profile'").get() as object) }, { body: "Has two cats: Oreo and Sylvester", instructions: "" });
  assert.equal((db.prepare("SELECT instructions FROM brain__revisions WHERE page_id = 'profile'").get() as { instructions: string }).instructions, "");
});

test("upgrade: a live page Me makes the subject Me 2, and a tombstoned Me 2 makes it Me 3", (t) => {
  const { subject, close } = upgrade((db) => {
    addPage(db, "x", "Me");
    db.prepare("INSERT INTO brain__tombstones (key, name, purged_at) VALUES ('me 2', 'Me 2', '')").run();
  });
  t.after(close);
  assert.equal(subject.name, "Me 3");
  const second = upgrade((db) => addPage(db, "x", "Me"));
  t.after(second.close);
  assert.equal(second.subject.name, "Me 2");
});
