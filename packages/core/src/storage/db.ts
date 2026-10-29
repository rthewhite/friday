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
    version: 13,
    name: "user privacy",
    // Every agent belongs to the user who created it. Rows without a user (agents, runs and conversations from before
    // users) are assigned to the household owner at startup once one exists, not here: a fresh install has none yet.
    // Conversations are listed per user, most recent activity first.
    // Agent jobs' history kept the agent's answer (summary) and error, readable on the admins' Jobs page: only the
    // outcome stays.
    sql: `
      ALTER TABLE agents ADD COLUMN created_by TEXT;
      CREATE INDEX conversations_user_activity ON conversations (user_id, last_activity_at DESC);
      UPDATE job_runs SET summary = CASE WHEN outcome = 'ok' THEN 'ok' ELSE NULL END, error = CASE WHEN error IS NULL THEN NULL ELSE outcome END
        WHERE job_id LIKE 'core/agent-%';
    `,
  },
  {
    version: 12,
    name: "module enablement",
    // The admin's on/off per in-process module. No row means enabled, so a fresh install and modules added later
    // load; rows for ids no longer in the module list are ignored and kept.
    sql: `
      CREATE TABLE module_enablement (
        module_id TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
        updated_at TEXT NOT NULL
      );
    `,
  },
  {
    version: 11,
    name: "users",
    // Users log in through OIDC and are keyed on (issuer, subject); the dev user has issuer and subject `dev`.
    // A session stores only the SHA-256 of its cookie token; the provider's refresh token is AES-256-GCM sealed
    // (AAD `auth:session` / `refresh_token`). auth_owner holds the household owner: one row, written once.
    // The user columns elsewhere are attribution only: nullable, never backfilled, no foreign key.
    sql: `
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        issuer TEXT NOT NULL,
        subject TEXT NOT NULL,
        email TEXT,
        name TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
        disabled INTEGER NOT NULL DEFAULT 0,
        first_login_at TEXT NOT NULL,
        last_login_at TEXT NOT NULL,
        UNIQUE (issuer, subject)
      );
      CREATE TABLE sessions (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        refresh_token_ct BLOB,
        refresh_token_iv BLOB,
        refresh_token_tag BLOB,
        created_at TEXT NOT NULL,
        last_used_at TEXT NOT NULL,
        refreshed_at TEXT NOT NULL
      );
      CREATE INDEX sessions_user ON sessions (user_id);
      CREATE TABLE auth_owner (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        user_id TEXT NOT NULL REFERENCES users (id),
        recorded_at TEXT NOT NULL
      );
      ALTER TABLE conversations ADD COLUMN user_id TEXT;
      ALTER TABLE agent_runs ADD COLUMN user_id TEXT;
      ALTER TABLE agent_actions ADD COLUMN decided_by TEXT;
    `,
  },
  {
    // agents merged first with 9, so this change took 10 at its rebase.
    version: 10,
    name: "oauth-connections",
    // One OAuth connection per provider. The client secret and both tokens are AES-256-GCM sealed (ciphertext, iv,
    // tag; AAD oauth:<provider> / <field>); the client id is plain. auth_url/token_url only for generic providers.
    // granted_scopes_json is what the provider reported at the last authorization. A grant lets one module get the
    // token; module_id has no foreign key so a grant survives a module leaving core's list.
    sql: `
      CREATE TABLE oauth_connections (
        provider TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        client_secret_ct BLOB,
        client_secret_iv BLOB,
        client_secret_tag BLOB,
        auth_url TEXT,
        token_url TEXT,
        extra_scopes_json TEXT NOT NULL DEFAULT '[]',
        access_token_ct BLOB,
        access_token_iv BLOB,
        access_token_tag BLOB,
        refresh_token_ct BLOB,
        refresh_token_iv BLOB,
        refresh_token_tag BLOB,
        expires_at TEXT,
        granted_scopes_json TEXT,
        state TEXT NOT NULL DEFAULT 'disconnected',
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE oauth_grants (
        provider TEXT NOT NULL REFERENCES oauth_connections (provider) ON DELETE CASCADE,
        module_id TEXT NOT NULL,
        granted_at TEXT NOT NULL,
        PRIMARY KEY (provider, module_id)
      );
    `,
  },
  {
    version: 9,
    name: "agents",
    // Agent definitions, their runs, and the calls parked for the user's approval (exact tool and arguments).
    // An MCP server's channels (JSON list; NULL = every channel), so a server can serve agents only.
    sql: `
      CREATE TABLE agents (
        name TEXT PRIMARY KEY,
        description TEXT NOT NULL,
        instructions TEXT NOT NULL,
        schedule TEXT,
        enabled INTEGER NOT NULL,
        startable INTEGER NOT NULL,
        tools_json TEXT NOT NULL,
        budgets_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE agent_runs (
        id TEXT PRIMARY KEY,
        agent TEXT NOT NULL REFERENCES agents(name) ON DELETE CASCADE,
        trigger TEXT NOT NULL,
        request TEXT,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        outcome TEXT NOT NULL,
        error TEXT,
        summary TEXT,
        tool_calls INTEGER NOT NULL DEFAULT 0,
        tokens INTEGER NOT NULL DEFAULT 0,
        conversation_id TEXT
      );
      CREATE INDEX agent_runs_agent_started ON agent_runs (agent, started_at DESC);
      CREATE TABLE agent_actions (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
        agent TEXT NOT NULL,
        tool TEXT NOT NULL,
        args_json TEXT NOT NULL,
        state TEXT NOT NULL,
        created_at TEXT NOT NULL,
        decided_at TEXT,
        result_json TEXT,
        error TEXT
      );
      CREATE INDEX agent_actions_run ON agent_actions (run_id);
      CREATE INDEX agent_actions_state ON agent_actions (state, created_at);
      ALTER TABLE mcp_servers ADD COLUMN channels_json TEXT;
    `,
  },
  {
    version: 8,
    name: "alerts",
    // Timers (and later alarms) that ring a target. next_ring_at is when the service next tries (or, while the device
    // rings it with its own tone, since when), so a restart resumes the ring cycle; rings counts unanswered rings;
    // local is set while the device rings it itself; snoozed_at is when the due time was last set again (a snooze or a changed timer).
    sql: `
      CREATE TABLE alerts (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        label TEXT NOT NULL,
        language TEXT NOT NULL,
        due_at TEXT NOT NULL,
        next_ring_at TEXT NOT NULL,
        target_kind TEXT NOT NULL,
        target_id TEXT NOT NULL,
        state TEXT NOT NULL,
        rings INTEGER NOT NULL DEFAULT 0,
        local INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        conversation_id TEXT,
        snoozed_at TEXT,
        finished_at TEXT
      );
      CREATE INDEX alerts_target_state ON alerts (target_kind, target_id, state);
    `,
  },
  {
    version: 7,
    name: "voice-devices",
    // Registered voice devices (key as a SHA-256 hash only) and pending connection attempts, one per claimed id.
    // An attempt can exist next to a device with the same id: that device came back with a different key.
    sql: `
      CREATE TABLE devices (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        area TEXT,
        notes TEXT,
        key_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        key_replaced_at TEXT,
        last_seen_at TEXT,
        revoked_at TEXT
      );
      CREATE TABLE device_attempts (
        device_id TEXT PRIMARY KEY,
        key_hash TEXT NOT NULL,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        attempts INTEGER NOT NULL
      );
    `,
  },
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
