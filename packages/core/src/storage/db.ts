/** Core's SQLite database: one file in FRIDAY_DATA_DIR, versioned migrations run at boot. */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

/**
 * What the search index holds for an entry: its text, or a tool call's name and the values in its arguments
 * (not their keys, never its result). Arguments cut at 4000 characters are no longer JSON and go in as text.
 */
const SEARCH_BODY = (e: string) => `CASE WHEN ${e}.kind = 'tool' THEN COALESCE(${e}.tool_name, '') || ' ' || CASE
    WHEN json_valid(${e}.tool_args) THEN COALESCE((SELECT group_concat(value, ' ') FROM json_tree(${e}.tool_args) WHERE type IN ('text', 'integer', 'real')), '')
    ELSE COALESCE(${e}.tool_args, '') END
  ELSE COALESCE(${e}.text, '') END`;

export const migrations: Migration[] = [
  {
    version: 6,
    name: "conversation-search",
    // Entries gain an explicit INTEGER PRIMARY KEY: the index is keyed by it, and an implicit rowid may be
    // renumbered by VACUUM. Then a full-text index over what was said, one row per entry. Contentless: the
    // text stays in conversation_entries. Triggers keep it in step, including cascaded deletes.
    sql: `
      CREATE TABLE conversation_entries_new (
        id INTEGER PRIMARY KEY,
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
        UNIQUE (conversation_id, seq)
      );
      INSERT INTO conversation_entries_new (conversation_id, seq, kind, input, text, interrupted, tool_name, tool_args, tool_result, truncated, at)
        SELECT conversation_id, seq, kind, input, text, interrupted, tool_name, tool_args, tool_result, truncated, at FROM conversation_entries ORDER BY conversation_id, seq;
      DROP TABLE conversation_entries;
      ALTER TABLE conversation_entries_new RENAME TO conversation_entries;
      CREATE VIRTUAL TABLE conversation_search USING fts5(body, content='', contentless_delete=1, tokenize='trigram remove_diacritics 1');
      CREATE TRIGGER conversation_search_insert AFTER INSERT ON conversation_entries BEGIN
        INSERT INTO conversation_search (rowid, body) VALUES (new.id, ${SEARCH_BODY("new")});
      END;
      CREATE TRIGGER conversation_search_delete AFTER DELETE ON conversation_entries BEGIN
        DELETE FROM conversation_search WHERE rowid = old.id;
      END;
      CREATE TRIGGER conversation_search_update AFTER UPDATE OF kind, text, tool_name, tool_args ON conversation_entries BEGIN
        DELETE FROM conversation_search WHERE rowid = old.id;
        INSERT INTO conversation_search (rowid, body) VALUES (new.id, ${SEARCH_BODY("new")});
      END;
      INSERT INTO conversation_search (rowid, body) SELECT id, ${SEARCH_BODY("conversation_entries")} FROM conversation_entries;
    `,
  },
  {
    version: 5,
    name: "mcp-servers",
    // HTTP MCP server definitions. Headers live in their own table in the config_values layout
    // (plaintext or AES-256-GCM ciphertext) and go away with their server.
    sql: `
      CREATE TABLE mcp_servers (
        name TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL DEFAULT 1,
        url TEXT NOT NULL,
        include_json TEXT,
        exclude_json TEXT,
        scheduling TEXT,
        prefix TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE mcp_server_headers (
        server TEXT NOT NULL REFERENCES mcp_servers(name) ON DELETE CASCADE,
        name TEXT NOT NULL,
        position INTEGER NOT NULL,
        secret INTEGER NOT NULL,
        plaintext TEXT,
        ciphertext BLOB,
        iv BLOB,
        tag BLOB,
        PRIMARY KEY (server, name)
      );
    `,
  },
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
    version: 3,
    name: "job-runs",
    // Run history per job (pruned to FRIDAY_JOB_HISTORY) and the due time of the last scheduled run, for catch-up.
    sql: `
      CREATE TABLE job_runs (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        trigger TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        outcome TEXT NOT NULL,
        summary TEXT,
        error TEXT
      );
      CREATE INDEX job_runs_job_started ON job_runs (job_id, started_at DESC);
      CREATE TABLE job_state (
        job_id TEXT PRIMARY KEY,
        last_due_at TEXT NOT NULL
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

/** Where friday.db lives in `dataDir`; modules open their own connections on the same file. */
export const databasePath = (dataDir: string, file = "friday.db"): string => join(dataDir, file);

export function openDatabase(dataDir: string, file = "friday.db", log: Pick<Console, "log"> = console): DatabaseSync {
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(databasePath(dataDir, file));
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
