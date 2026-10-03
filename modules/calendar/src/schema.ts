/** The calendar's tables (design D6): one log of every change Friday made, with whole objects so undo is uniform. */
import type { ModuleMigration } from "@friday/sdk";

export const migrations: ModuleMigration[] = [
  {
    version: 1,
    name: "changes",
    up: `
      CREATE TABLE calendar__changes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL,
        action TEXT NOT NULL,            -- create | update | delete | undo
        scope TEXT,                      -- occurrence | series | NULL (not recurring)
        calendar_id TEXT NOT NULL,
        object_url TEXT NOT NULL,
        uid TEXT NOT NULL,
        title TEXT NOT NULL,
        before_summary TEXT,             -- JSON { title, when, calendar?, location? }
        after_summary TEXT,
        before_ics TEXT,                 -- the whole object before; NULL when it didn't exist
        after_ics TEXT,                  -- the whole object after; NULL when it was deleted
        after_etag TEXT,
        source TEXT NOT NULL,            -- voice | chat | portal
        conversation_id TEXT,
        undo_of INTEGER,                 -- for undo rows: the change they reverted
        undone_by INTEGER                -- the undo row that reverted this change
      );
    `,
  },
];
