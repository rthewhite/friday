import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createTestHost } from "@friday/sdk/test";
import { createBrainModule } from "../src/index.js";
import { jarvisUsers, readJarvisExport } from "../scripts/jarvis-export.js";

/** A file with the tables of Jarvis's brain (packages/brain/src/db/database.ts), for two users. */
function jarvisFile(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "jarvis-brain-memories.db");
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE documents (
      id TEXT PRIMARY KEY, username TEXT NOT NULL, name TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('person','place','project','other')),
      aliases TEXT NOT NULL DEFAULT '[]', body TEXT NOT NULL DEFAULT '', is_profile INTEGER NOT NULL DEFAULT 0,
      current_revision_id TEXT, deleted_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE document_tombstones (username TEXT NOT NULL, name_lower TEXT NOT NULL, purged_at TEXT NOT NULL, PRIMARY KEY (username, name_lower));
    CREATE TABLE memories (id TEXT PRIMARY KEY, username TEXT, content TEXT);
    CREATE TABLE document_revisions (id TEXT PRIMARY KEY, document_id TEXT, body TEXT);
  `);
  const doc = db.prepare("INSERT INTO documents (id, username, name, type, aliases, body, is_profile, deleted_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  doc.run("p0", "rdewit", "Profile", "other", "[]", "Lives in Amsterdam.", 1, null, "2026-01-01T00:00:00Z", "2026-09-01T00:00:00Z");
  doc.run("p1", "rdewit", "Anouk", "person", '["Noukie"]', "Sister. See [[Family]].", 0, null, "2026-01-02T00:00:00Z", "2026-08-01T00:00:00Z");
  doc.run("p2", "rdewit", "Family", "other", "[]", "- [[Anouk]]", 0, null, "2026-01-03T00:00:00Z", "2026-07-01T00:00:00Z");
  doc.run("p3", "rdewit", "Old car", "other", "not json", "Red Fiat", 0, "2026-03-01T00:00:00Z", "2026-01-04T00:00:00Z", "2026-02-01T00:00:00Z");
  doc.run("q0", "sam", "Profile", "other", "[]", "Sam's own profile", 1, null, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z");
  doc.run("q1", "sam", "Work", "project", "[]", "Sam's page", 0, null, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z");
  db.prepare("INSERT INTO document_tombstones VALUES (?, ?, ?)").run("rdewit", "old job", "2026-04-01T00:00:00Z");
  db.prepare("INSERT INTO document_tombstones VALUES (?, ?, ?)").run("sam", "secret", "2026-04-01T00:00:00Z");
  db.prepare("INSERT INTO memories VALUES ('m1', 'rdewit', 'legacy fact row')").run();
  db.close();
  return file;
}

test("the reader takes one user's profile, live and deleted pages and tombstones, nothing else", (t) => {
  const file = jarvisFile(t);
  assert.deepEqual(jarvisUsers(file), ["rdewit", "sam"]);
  const { payload, notes } = readJarvisExport(file, "rdewit");
  assert.deepEqual(payload.profile, { body: "Lives in Amsterdam.", aliases: [] });
  assert.deepEqual(payload.pages, [
    { name: "Family", type: "other", aliases: [], body: "- [[Anouk]]", createdAt: "2026-01-03T00:00:00Z", updatedAt: "2026-07-01T00:00:00Z" },
    { name: "Anouk", type: "person", aliases: ["Noukie"], body: "Sister. See [[Family]].", createdAt: "2026-01-02T00:00:00Z", updatedAt: "2026-08-01T00:00:00Z" },
  ]);
  assert.deepEqual(payload.deleted, [{ name: "Old car", type: "other", aliases: [], body: "Red Fiat", createdAt: "2026-01-04T00:00:00Z", updatedAt: "2026-02-01T00:00:00Z", deletedAt: "2026-03-01T00:00:00Z" }]);
  assert.deepEqual(payload.tombstones, [{ name: "old job", purgedAt: "2026-04-01T00:00:00Z" }]);
  assert.deepEqual(notes, ['Old car: aliases "not json" are not a JSON list of strings; imported without aliases']);
  assert.ok(!JSON.stringify(payload).includes("Sam") && !JSON.stringify(payload).includes("legacy fact row"));
});

test("the read payload imports cleanly into an empty brain", async (t) => {
  const file = jarvisFile(t);
  const { payload } = readJarvisExport(file, "rdewit");
  const h = await createTestHost(createBrainModule());
  const r = await h.request("POST", "import", { ...payload, dryRun: false });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const list = (await h.request("GET", "pages")).body as { pages: { name: string; body: string }[]; deleted: { name: string }[] };
  assert.deepEqual(list.pages.map((p) => p.name), ["Profile", "Anouk", "Family"]);
  assert.deepEqual(list.deleted.map((d) => d.name), ["Old car"]);
});
