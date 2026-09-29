/** The brain's tables (design D1). Migration 1 also seeds the profile so it exists from the first start. */
import type { ModuleMigration } from "@friday/sdk";

/** The profile's fixed id and name. */
export const PROFILE_ID = "profile";
export const PROFILE_NAME = "Profile";

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
        -- A full snapshot per write. Integer ids give revisions a total order (no AUTOINCREMENT).
        CREATE TABLE brain__revisions (
          id INTEGER PRIMARY KEY,
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
];
