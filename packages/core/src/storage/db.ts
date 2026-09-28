/** Core's SQLite database: one file in FRIDAY_DATA_DIR, versioned migrations run at boot. */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const migrations: Migration[] = [
  {
    version: 4,
    name: "conversations",
    // Transcript text only. preview and entry_count are kept on the conversation so listing never reads entries.
    sql: `
      CREATE TABLE conversations (
        id TEXT PRIMARY KEY,
        channel TEXT NOT NULL,
        device TEXT,
        started_at TEXT NOT NULL,
        last_activity_at TEXT NOT NULL,
        ended_at TEXT,
        end_reason TEXT,
        quiet_at TEXT,
        entry_count INTEGER NOT NULL DEFAULT 0,
        preview TEXT
      );
      CREATE INDEX conversations_last_activity ON conversations (last_activity_at DESC);
      CREATE INDEX conversations_quiet ON conversations (quiet_at);
      CREATE TABLE conversation_entries (
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        kind TEXT NOT NULL,
        input TEXT,
        text TEXT,
        interrupted INTEGER NOT NULL DEFAULT 0,
        tool_name TEXT,
        tool_args TEXT,
        tool_result TEXT,
        truncated INTEGER NOT NULL DEFAULT 0,
        at TEXT NOT NULL,
        PRIMARY KEY (conversation_id, seq)
      );
    `,
  },
  {
    version: 2,
    name: "plain-config-values",
    // Existing rows are all encrypted; they stay secret until the user re-saves them as plain.
    sql: `
      ALTER TABLE config_values ADD COLUMN secret INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE config_values ADD COLUMN plaintext TEXT;
    `,
  },
  {
    version: 1,
    name: "initial",
    sql: `
      CREATE TABLE config_values (
        scope TEXT NOT NULL,
        key TEXT NOT NULL,
        ciphertext BLOB NOT NULL,
        iv BLOB NOT NULL,
        tag BLOB NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (scope, key)
      );
      CREATE TABLE module_keys (
        id TEXT PRIMARY KEY,
        module_id TEXT NOT NULL,
        key_hash TEXT NOT NULL UNIQUE,
        label TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_seen_at TEXT,
        revoked_at TEXT
      );
      CREATE TABLE module_kv (
        module_id TEXT NOT NULL,
        key TEXT NOT NULL,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (module_id, key)
      );
    `,
  },
];

export function openDatabase(dataDir: string, file = "friday.db", log: Pick<Console, "log"> = console): DatabaseSync {
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(join(dataDir, file));
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  migrate(db, migrations, log);
  return db;
}

export function schemaVersion(db: DatabaseSync): number {
  db.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)");
  const row = db.prepare("SELECT version FROM schema_version").get() as { version: number } | undefined;
  return row?.version ?? 0;
}

/** Apply pending migrations in one transaction each; a failure aborts with the migration name. */
export function migrate(db: DatabaseSync, all: Migration[], log: Pick<Console, "log"> = console): number {
  let current = schemaVersion(db);
  let applied = 0;
  for (const m of [...all].sort((a, b) => a.version - b.version)) {
    if (m.version <= current) continue;
    db.exec("BEGIN");
    try {
      db.exec(m.sql);
      db.exec("DELETE FROM schema_version");
      db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(m.version);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw new Error(`migration ${m.version} (${m.name}) failed: ${e instanceof Error ? e.message : e}`);
    }
    current = m.version;
    applied++;
    log.log(`storage: applied migration ${m.version} ${m.name}`);
  }
  return applied;
}
