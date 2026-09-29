/**
 * Module-owned tables in friday.db: the synchronous `ctx.db` handle, the prefix authorizer that
 * keeps a module inside its own namespace, and the migration runner. Shared by core's host and the
 * test host so both apply the same rules. Imported only by hosts, never by `@friday/sdk/remote`.
 */
import { constants as C, DatabaseSync, type StatementSync } from "node:sqlite";
import { MODULE_ID, type ModuleLogger } from "./module.js";
import { isThenable } from "./thenable.js";

/**
 * Synchronous access to the module's tables. Statements are node's `StatementSync`
 * (`run`, `get`, `all`, `iterate`). Everything a statement touches must be named `<prefix>__*`.
 */
export interface ModuleDb {
  prepare(sql: string): StatementSync;
  /** Runs one or more statements without results. */
  exec(sql: string): void;
  /**
   * Runs `fn` in a transaction (`BEGIN IMMEDIATE`): commits when it returns, rolls back and rethrows
   * when it throws. `fn` must be synchronous; returning a promise rolls back and throws. A call inside
   * another uses a savepoint, so it rolls back on its own without ending the outer transaction.
   */
  transaction<T>(fn: () => T): T;
}

/** One schema step. `up` is SQL or a function over the module's handle; both run in the step's transaction. */
export interface ModuleMigration {
  /** Positive integer, unique within the module. Pending steps run in ascending order. */
  version: number;
  name: string;
  up: string | ((db: ModuleDb) => void);
}

/** `brain` → `brain__`, `media-x` → `media_x__`. Throws for ids whose prefix could overlap another module's. */
export function tablePrefix(moduleId: string): string {
  if (!MODULE_ID.test(moduleId)) throw new Error(`invalid module id ${JSON.stringify(moduleId)}`);
  if (moduleId.includes("--") || moduleId.endsWith("-")) {
    throw new Error(`module ${moduleId}: an id with "--" or a trailing "-" cannot own tables (its table prefix would overlap another module's)`);
  }
  return `${moduleId.replaceAll("-", "_")}__`;
}

/** The core-owned table that records each module's schema version; reachable only by the runner. */
const SCHEMA_TABLE = "module_schema";

/** What a host holds for one module: the handle it passes as `ctx.db`, the migration runner, and `close`. */
export interface ModuleDatabase {
  readonly db: ModuleDb;
  /** The recorded schema version (0 when the module never ran a migration). */
  version(): number;
  /** Validates `migrations`, then runs the pending ones. Returns the versions applied. */
  migrate(migrations: readonly ModuleMigration[] | undefined, log?: ModuleLogger): number[];
  close(): void;
}

export interface OpenModuleDbOptions {
  /** How long a statement waits for another connection's write lock before failing (default 5000 ms). */
  busyTimeoutMs?: number;
}

/**
 * Opens a connection for one module on `location` (a file path, or `:memory:` for tests) with foreign
 * keys on and the prefix authorizer installed. Throws when the id cannot own tables or this Node has
 * no `DatabaseSync#setAuthorizer`.
 */
export function openModuleDb(location: string, moduleId: string, opts: OpenModuleDbOptions = {}): ModuleDatabase {
  const prefix = tablePrefix(moduleId);
  const raw = new DatabaseSync(location);
  if (typeof (raw as Partial<DatabaseSync>).setAuthorizer !== "function") {
    raw.close();
    throw new Error(`module ${moduleId}: ctx.db needs Node 24.10 or later (DatabaseSync#setAuthorizer)`);
  }
  raw.exec(`PRAGMA foreign_keys = ON; PRAGMA busy_timeout = ${Math.max(0, Math.floor(opts.busyTimeoutMs ?? 5000))};`);

  /** Set around the runner's own statements so they may use `module_schema`. Modules never see it. */
  let internal = false;
  /** Set around `transaction()`'s own BEGIN / SAVEPOINT / COMMIT / ROLLBACK; modules can't issue them. */
  let control = false;
  /** SQL being prepared, for the rename check (the authorizer is not told a table's new name). */
  let current: string | undefined;
  /** First operation refused while preparing the current statement, for the error message. */
  let refused: string | undefined;
  /**
   * DDL or ANALYZE on the module's own objects was allowed in the current prepare/exec call: SQLite then
   * updates its bookkeeping tables itself. The authorizer can't tell statements of one exec apart, so this
   * holds for the rest of the call; it stops plain module statements, not a deliberate combination.
   */
  let ddl = false;

  const own = (n: string): boolean => n.startsWith(prefix) || (internal && n === SCHEMA_TABLE);
  /** Names a module may use as objects: its own, and SQLite's internal ones (which SQLite itself refuses to create or drop). */
  const owned = (name: string | null): boolean => {
    if (!name) return false;
    const n = name.toLowerCase();
    return own(n) || n.startsWith("sqlite_");
  };
  /**
   * Writes to SQLite's internal tables: the schema tables are guarded by SQLite itself (writable_schema
   * is a refused pragma). The shared AUTOINCREMENT counters only change as a side effect of the module's
   * own DDL (see `ddl`), and planner statistics can be dropped but never written by a module.
   */
  const writable = (name: string | null, del = false): boolean => {
    if (!name) return false;
    const n = name.toLowerCase();
    if (own(n) || n === "sqlite_master" || n === "sqlite_schema" || n === "sqlite_temp_master" || n === "sqlite_temp_schema") return true;
    // ANALYZE deletes old statistics before it is authorized; dropping statistics only reverts to default plans.
    if (n.startsWith("sqlite_stat")) return del;
    return ddl && n === "sqlite_sequence";
  };
  const deny = (what: string): number => {
    refused ??= what;
    return C.SQLITE_DENY;
  };
  const check = (action: string, ...names: (string | null)[]): number => {
    for (const n of names) if (!owned(n)) return deny(`${action} ${n ?? "(unnamed)"}`);
    return C.SQLITE_OK;
  };
  const write = (action: string, name: string | null): number => (writable(name, action === "delete from") ? C.SQLITE_OK : deny(`${action} ${name ?? "(unnamed)"}`));
  const schemaChange = (result: number): number => {
    if (result === C.SQLITE_OK) ddl = true;
    return result;
  };

  raw.setAuthorizer((code, arg1, arg2) => {
    switch (code) {
      case C.SQLITE_SELECT:
      case C.SQLITE_FUNCTION:
      case C.SQLITE_RECURSIVE:
        return C.SQLITE_OK;
      // A module-issued BEGIN could hold the write lock across an await; transactions go through transaction().
      case C.SQLITE_TRANSACTION:
      case C.SQLITE_SAVEPOINT:
        return control ? C.SQLITE_OK : deny(`${arg1?.toLowerCase() ?? "transaction"} statement (use ctx.db.transaction)`);
      case C.SQLITE_READ: return check("read", arg1);
      case C.SQLITE_INSERT: return write("insert into", arg1);
      case C.SQLITE_UPDATE: return write("update", arg1);
      case C.SQLITE_DELETE: return write("delete from", arg1);
      case C.SQLITE_CREATE_TABLE:
      case C.SQLITE_CREATE_TEMP_TABLE: return schemaChange(check("create table", arg1));
      case C.SQLITE_DROP_TABLE:
      case C.SQLITE_DROP_TEMP_TABLE: return schemaChange(check("drop table", arg1));
      case C.SQLITE_CREATE_VIEW:
      case C.SQLITE_CREATE_TEMP_VIEW: return schemaChange(check("create view", arg1));
      case C.SQLITE_DROP_VIEW:
      case C.SQLITE_DROP_TEMP_VIEW: return schemaChange(check("drop view", arg1));
      // arg2 is the virtual table module (fts5, ...), not a schema object.
      case C.SQLITE_CREATE_VTABLE: return schemaChange(check("create virtual table", arg1));
      case C.SQLITE_DROP_VTABLE: return schemaChange(check("drop virtual table", arg1));
      // arg1 is the index or trigger, arg2 the table it belongs to.
      case C.SQLITE_CREATE_INDEX:
      case C.SQLITE_CREATE_TEMP_INDEX: return schemaChange(check("create index", arg1, arg2));
      case C.SQLITE_DROP_INDEX:
      case C.SQLITE_DROP_TEMP_INDEX: return schemaChange(check("drop index", arg1, arg2));
      case C.SQLITE_CREATE_TRIGGER:
      case C.SQLITE_CREATE_TEMP_TRIGGER: return schemaChange(check("create trigger", arg1, arg2));
      case C.SQLITE_DROP_TRIGGER:
      case C.SQLITE_DROP_TEMP_TRIGGER: return schemaChange(check("drop trigger", arg1, arg2));
      case C.SQLITE_REINDEX: return schemaChange(check("reindex", arg1));
      case C.SQLITE_ANALYZE: return schemaChange(check("analyze", arg1));
      // arg1 is the database, arg2 the table.
      case C.SQLITE_ALTER_TABLE: {
        if (check("alter table", arg2) !== C.SQLITE_OK) return C.SQLITE_DENY;
        for (const to of renameTargets(current ?? "")) if (!own(to.toLowerCase())) return deny(`rename table to ${to}`);
        return schemaChange(C.SQLITE_OK);
      }
      // FTS5 reads data_version internally; every other pragma (foreign_keys, writable_schema, ...) is refused.
      case C.SQLITE_PRAGMA:
        return arg1?.toLowerCase() === "data_version" && arg2 === null ? C.SQLITE_OK : deny(`pragma ${arg1}`);
      case C.SQLITE_ATTACH: return deny("attach");
      case C.SQLITE_DETACH: return deny("detach");
      default: return deny(`operation ${code}`);
    }
  });

  /** Runs a prepare or exec, turning an authorizer refusal into an error that names the module. */
  const guarded = <T>(sql: string, run: () => T): T => {
    current = sql;
    refused = undefined;
    ddl = false;
    try {
      return run();
    } catch (e) {
      if (refused !== undefined || (e as { errcode?: number }).errcode === 23) {
        throw new Error(`module ${moduleId}: database access refused: ${refused ?? "not authorized"} (a module may only use ${prefix}* tables, and no pragmas or attached databases)`, { cause: e });
      }
      throw e;
    } finally {
      current = undefined;
      ddl = false;
    }
  };

  /** transaction()'s own control statements, the only ones the authorizer lets through. */
  const txn = (sql: string): void => {
    control = true;
    try {
      raw.exec(sql);
    } finally {
      control = false;
    }
  };

  let savepoints = 0;
  const db: ModuleDb = {
    prepare: (sql) => guarded(sql, () => raw.prepare(sql)),
    exec: (sql) => guarded(sql, () => raw.exec(sql)),
    transaction<T>(fn: () => T): T {
      const savepoint = raw.isTransaction ? `friday_sp_${++savepoints}` : undefined;
      txn(savepoint ? `SAVEPOINT ${savepoint}` : "BEGIN IMMEDIATE");
      // Never lets a failed rollback hide the error that caused it.
      const rollback = () => {
        try {
          if (raw.isTransaction) txn(savepoint ? `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}` : "ROLLBACK");
        } catch {
          // the transaction is already gone
        }
      };
      let result: T;
      try {
        result = fn();
      } catch (e) {
        rollback();
        throw e;
      }
      if (isThenable(result)) {
        rollback();
        // The body keeps running after its first await; don't let its failure become an unhandled rejection.
        void Promise.resolve(result).catch(() => {});
        throw new Error(`module ${moduleId}: transaction bodies must be synchronous (the body returned a promise; nothing it wrote before its first await was kept)`);
      }
      try {
        txn(savepoint ? `RELEASE ${savepoint}` : "COMMIT");
      } catch (e) {
        rollback();
        throw e;
      }
      return result;
    },
  };

  /** The runner's own statements: `module_schema` is reachable only inside this window. */
  const asHost = <T>(fn: () => T): T => {
    internal = true;
    try {
      return fn();
    } finally {
      internal = false;
    }
  };
  const version = (): number => asHost(() => {
    raw.exec(`CREATE TABLE IF NOT EXISTS ${SCHEMA_TABLE} (module_id TEXT PRIMARY KEY, version INTEGER NOT NULL, updated_at TEXT NOT NULL)`);
    const row = raw.prepare(`SELECT version FROM ${SCHEMA_TABLE} WHERE module_id = ?`).get(moduleId) as { version: number } | undefined;
    return row?.version ?? 0;
  });

  return {
    db,
    version,
    migrate(migrations, log) {
      const steps = validateMigrations(moduleId, migrations ?? []);
      if (!steps.length) return [];
      const recorded = version();
      const latest = steps[steps.length - 1].version;
      if (recorded > latest) throw new Error(`database schema v${recorded} is newer than module ${moduleId}'s migrations (v${latest})`);
      const applied: number[] = [];
      for (const m of steps) {
        if (m.version <= recorded) continue;
        try {
          db.transaction(() => {
            const before = schemaNames(raw);
            if (typeof m.up === "string") db.exec(m.up);
            else {
              const r: unknown = m.up(db);
              if (isThenable(r)) {
                void Promise.resolve(r).catch(() => {});
                throw new Error("migration functions must be synchronous (up returned a promise)");
              }
            }
            // Backstop for the authorizer: whatever the SQL looked like, nothing new may sit outside the prefix.
            for (const name of schemaNames(raw)) {
              if (!before.has(name) && !name.startsWith(prefix) && !name.startsWith("sqlite_")) {
                throw new Error(`module ${moduleId}: database access refused: the migration created ${name} (a module may only use ${prefix}* tables)`);
              }
            }
            asHost(() => raw
              .prepare(`INSERT INTO ${SCHEMA_TABLE} (module_id, version, updated_at) VALUES (?, ?, ?) ON CONFLICT(module_id) DO UPDATE SET version = excluded.version, updated_at = excluded.updated_at`)
              .run(moduleId, m.version, new Date().toISOString()));
          });
        } catch (e) {
          throw new Error(`module ${moduleId}: migration ${m.version} "${m.name}" failed: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
        }
        applied.push(m.version);
        log?.log(`migration ${m.version} "${m.name}" applied`);
      }
      return applied;
    },
    close: () => raw.close(),
  };
}

/** A `ctx.db` that asks `open` for the module's connection at each call; hosts memoize `open` to open lazily. */
export function lazyDb(open: () => ModuleDatabase): ModuleDb {
  return {
    prepare: (sql) => open().db.prepare(sql),
    exec: (sql) => open().db.exec(sql),
    transaction: (fn) => open().db.transaction(fn),
  };
}

/** Checks the whole list before anything runs; returns it sorted by version. */
export function validateMigrations(moduleId: string, migrations: readonly ModuleMigration[]): ModuleMigration[] {
  if (!Array.isArray(migrations)) throw new Error(`module ${moduleId}: migrations must be a list`);
  const seen = new Set<number>();
  for (const m of migrations) {
    const v = m?.version;
    if (!Number.isInteger(v) || v <= 0) throw new Error(`module ${moduleId}: migration version ${JSON.stringify(v)} is not a positive integer`);
    if (seen.has(v)) throw new Error(`module ${moduleId}: duplicate migration version ${v}`);
    seen.add(v);
    if (typeof m.name !== "string" || !m.name.trim()) throw new Error(`module ${moduleId}: migration ${v} has no name`);
    if (typeof m.up !== "string" && typeof m.up !== "function") throw new Error(`module ${moduleId}: migration ${v} "${m.name}" has no up (SQL or a function)`);
  }
  return [...migrations].sort((a, b) => a.version - b.version);
}

/**
 * Table names after `RENAME TO` in `sql` (quoted or bare), with comments removed first so they
 * can't split the keywords. `RENAME [COLUMN] a TO b` renames a column and is not matched.
 */
export function renameTargets(sql: string): string[] {
  const out: string[] = [];
  for (const m of withoutComments(sql).matchAll(/\bRENAME\s+TO\s+(?:"((?:[^"]|"")*)"|`((?:[^`]|``)*)`|\[([^\]]*)\]|'((?:[^']|'')*)'|([^\s;]+))/gi)) {
    out.push((m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5]).replace(/""|``|''/g, (q) => q[0]));
  }
  return out;
}

/** `sql` with `--` and `/* *\/` comments replaced by a space; quoted text is kept as is. */
function withoutComments(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (c === "'" || c === '"' || c === "`" || c === "[") {
      const close = c === "[" ? "]" : c;
      let j = i + 1;
      for (;;) {
        if (j >= sql.length) break;
        if (sql[j] === close) {
          if (close !== "]" && sql[j + 1] === close) j += 2;
          else break;
        } else j++;
      }
      out += sql.slice(i, j + 1);
      i = j + 1;
    } else if (c === "-" && sql[i + 1] === "-") {
      const end = sql.indexOf("\n", i);
      i = end === -1 ? sql.length : end;
      out += " ";
    } else if (c === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? sql.length : end + 2;
      out += " ";
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** Names of every schema object, for spotting what a migration created. */
function schemaNames(raw: DatabaseSync): Set<string> {
  const rows = raw.prepare("SELECT name FROM sqlite_master UNION SELECT name FROM sqlite_temp_master").all() as { name: string }[];
  return new Set(rows.map((r) => r.name.toLowerCase()));
}

