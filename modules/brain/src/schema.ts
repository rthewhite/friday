/**
 * The brain's tables (design D1). Migration 1 also seeds the profile so it exists from the first start;
 * migration 3 gives the profile its instructions and its subject page (hybrid-profile D1, D10).
 */
import { randomUUID } from "node:crypto";
import type { ModuleDb, ModuleMigration } from "@friday/sdk";
import { nameKey } from "./links.js";

/** The profile's fixed id and name. */
export const PROFILE_ID = "profile";
export const PROFILE_NAME = "Profile";
/** The subject page's first name, until the user gives it theirs. */
export const SUBJECT_NAME = "Me";

export const migrations: ModuleMigration[] = [
  {
    version: 1,
    name: "pages",
    up(db) {
      db.exec(`
        CREATE TABLE brain__pages (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          type TEXT NOT NULL,
          aliases_json TEXT NOT NULL DEFAULT '[]',
          body TEXT NOT NULL DEFAULT '',
          is_profile INTEGER NOT NULL DEFAULT 0,
          revision_id INTEGER,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          deleted_at TEXT
        );
        CREATE INDEX brain__pages_updated ON brain__pages (updated_at DESC);
        CREATE UNIQUE INDEX brain__pages_one_profile ON brain__pages (is_profile) WHERE is_profile = 1;
        -- Names and aliases of live pages; the primary key makes them unique across the brain.
        CREATE TABLE brain__names (
          key TEXT PRIMARY KEY,
          page_id TEXT NOT NULL REFERENCES brain__pages (id) ON DELETE CASCADE,
          kind TEXT NOT NULL
        );
        CREATE INDEX brain__names_page ON brain__names (page_id);
        -- A full snapshot per write. AUTOINCREMENT keeps ids increasing even after a purge deletes the
        -- highest ones, so "revisions since id N" (brain-nightly) never misses a write.
        CREATE TABLE brain__revisions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          page_id TEXT NOT NULL REFERENCES brain__pages (id) ON DELETE CASCADE,
          author TEXT NOT NULL,
          base_revision_id INTEGER,
          name TEXT NOT NULL,
          type TEXT NOT NULL,
          aliases_json TEXT NOT NULL,
          body TEXT NOT NULL,
          sources_json TEXT NOT NULL DEFAULT '[]',
          note TEXT,
          created_at TEXT NOT NULL
        );
        CREATE INDEX brain__revisions_page ON brain__revisions (page_id, id DESC);
        CREATE INDEX brain__revisions_created ON brain__revisions (created_at);
        -- Name keys of purged pages: non-user writes may not bring them back.
        CREATE TABLE brain__tombstones (
          key TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          purged_at TEXT NOT NULL
        );
      `);
      const now = new Date().toISOString();
      db.prepare("INSERT INTO brain__pages (id, name, type, aliases_json, body, is_profile, revision_id, created_at, updated_at) VALUES (?, ?, 'other', '[]', '', 1, 1, ?, ?)").run(PROFILE_ID, PROFILE_NAME, now, now);
      db.prepare("INSERT INTO brain__revisions (id, page_id, author, name, type, aliases_json, body, note, created_at) VALUES (1, ?, 'system', ?, 'other', '[]', '', 'created', ?)").run(PROFILE_ID, PROFILE_NAME, now);
      db.prepare("INSERT INTO brain__names (key, page_id, kind) VALUES ('profile', ?, 'name')").run(PROFILE_ID);
    },
  },
  {
    version: 2,
    name: "nightly-runs",
    // One row per brain/nightly run (brain-nightly design D1): counts, dropped lines, merges, and the
    // range of revision ids it may have written, for the Nightly review and revert.
    up: `
      CREATE TABLE brain__runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        trigger TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        outcome TEXT,
        conversations INTEGER NOT NULL DEFAULT 0,
        skipped INTEGER NOT NULL DEFAULT 0,
        notes INTEGER NOT NULL DEFAULT 0,
        refused INTEGER NOT NULL DEFAULT 0,
        rewrites INTEGER NOT NULL DEFAULT 0,
        creates INTEGER NOT NULL DEFAULT 0,
        merges INTEGER NOT NULL DEFAULT 0,
        dropped_json TEXT NOT NULL DEFAULT '[]',
        merges_json TEXT NOT NULL DEFAULT '[]',
        first_revision_id INTEGER NOT NULL,
        last_revision_id INTEGER,
        error TEXT,
        summary TEXT
      );
      CREATE INDEX brain__runs_started ON brain__runs (started_at DESC);
    `,
  },
  {
    version: 3,
    name: "profile-subject",
    up(db) {
      db.exec(`
        ALTER TABLE brain__pages ADD COLUMN instructions TEXT;
        ALTER TABLE brain__pages ADD COLUMN subject_id TEXT;
        ALTER TABLE brain__revisions ADD COLUMN instructions TEXT;
        ALTER TABLE brain__runs ADD COLUMN summary_generated INTEGER NOT NULL DEFAULT 0;
        UPDATE brain__pages SET instructions = '' WHERE is_profile = 1;
        UPDATE brain__revisions SET instructions = '' WHERE page_id = '${PROFILE_ID}';
      `);
      moveProfileToSubject(db);
    },
  },
  {
    version: 4,
    name: "revision-user",
    // Who made a portal edit (author `user`): the id and the name at the time. A module can't read core's users,
    // so the name is kept with the revision. Earlier revisions and other authors have none.
    up(db) {
      db.exec(`
        ALTER TABLE brain__revisions ADD COLUMN user_id TEXT;
        ALTER TABLE brain__revisions ADD COLUMN user_name TEXT;
      `);
    },
  },
  {
    version: 5,
    name: "brain-per-user",
    // A brain per user (user-privacy): pages, names, tombstones and runs belong to one user, names are unique within
    // a user's brain, and each user has one profile. Existing rows keep no user here; they go to the household owner
    // once there is one (users.ts), since a fresh install has none yet. Revisions follow their page; their ids stay
    // global, so "revisions since N" still works. Names and tombstones are rebuilt for their new primary key.
    up(db) {
      db.exec(`
        ALTER TABLE brain__pages ADD COLUMN user_id TEXT;
        ALTER TABLE brain__runs ADD COLUMN user_id TEXT;
        DROP INDEX brain__pages_one_profile;
        CREATE UNIQUE INDEX brain__pages_one_profile ON brain__pages (COALESCE(user_id, '')) WHERE is_profile = 1;
        CREATE INDEX brain__pages_user_updated ON brain__pages (user_id, updated_at DESC);
        CREATE INDEX brain__runs_user ON brain__runs (user_id, id DESC);

        CREATE TABLE brain__names_new (
          user_id TEXT,
          key TEXT NOT NULL,
          page_id TEXT NOT NULL REFERENCES brain__pages (id) ON DELETE CASCADE,
          kind TEXT NOT NULL,
          PRIMARY KEY (user_id, key)
        );
        INSERT INTO brain__names_new (user_id, key, page_id, kind) SELECT NULL, key, page_id, kind FROM brain__names;
        DROP TABLE brain__names;
        ALTER TABLE brain__names_new RENAME TO brain__names;
        CREATE INDEX brain__names_page ON brain__names (page_id);

        CREATE TABLE brain__tombstones_new (
          user_id TEXT,
          key TEXT NOT NULL,
          name TEXT NOT NULL,
          purged_at TEXT NOT NULL,
          PRIMARY KEY (user_id, key)
        );
        INSERT INTO brain__tombstones_new (user_id, key, name, purged_at) SELECT NULL, key, name, purged_at FROM brain__tombstones;
        DROP TABLE brain__tombstones;
        ALTER TABLE brain__tombstones_new RENAME TO brain__tombstones;
      `);
    },
  },
];

/**
 * Creates the subject page from the profile's current body (named `Me`, or `Me 2`, `Me 3`… when that name
 * is live or tombstoned) and points the profile at it. The profile keeps its body as the summary until
 * the nightly pass generates one.
 */
function moveProfileToSubject(db: ModuleDb): void {
  const profile = db.prepare("SELECT body FROM brain__pages WHERE id = ?").get(PROFILE_ID) as { body: string };
  const taken = (name: string) =>
    !!db.prepare("SELECT 1 FROM brain__names WHERE key = ?").get(nameKey(name)) || !!db.prepare("SELECT 1 FROM brain__tombstones WHERE key = ?").get(nameKey(name));
  let name = SUBJECT_NAME;
  for (let n = 2; taken(name); n++) name = `${SUBJECT_NAME} ${n}`;
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare("INSERT INTO brain__pages (id, name, type, aliases_json, body, created_at, updated_at) VALUES (?, ?, 'person', '[]', ?, ?, ?)").run(id, name, profile.body, now, now);
  const rev = Number(db
    .prepare("INSERT INTO brain__revisions (page_id, author, name, type, aliases_json, body, note, created_at) VALUES (?, 'system', ?, 'person', '[]', ?, 'moved from the profile', ?)")
    .run(id, name, profile.body, now).lastInsertRowid);
  db.prepare("UPDATE brain__pages SET revision_id = ? WHERE id = ?").run(rev, id);
  db.prepare("INSERT INTO brain__names (key, page_id, kind) VALUES (?, ?, 'name')").run(nameKey(name), id);
  db.prepare("UPDATE brain__pages SET subject_id = ? WHERE id = ?").run(id, PROFILE_ID);
}
