/**
 * Module-owned tables in friday.db: the synchronous `ctx.db` handle, the prefix authorizer that
 * keeps a module inside its own namespace, and the migration runner. Shared by core's host and the
 * test host so both apply the same rules. Imported only by hosts, never by `@friday/sdk/remote`.
 */
import { constants as C, DatabaseSync, type StatementSync } from "node:sqlite";
import type { ModuleLogger } from "./module.js";

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

const ID = /^[a-z][a-z0-9-]*$/;

/** `brain` → `brain__`, `media-x` → `media_x__`. Throws for ids whose prefix could overlap another module's. */
export function tablePrefix(moduleId: string): string {
  if (!ID.test(moduleId)) throw new Error(`invalid module id ${JSON.stringify(moduleId)}`);
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
  /** SQL being prepared, for the rename check (the authorizer is not told a table's new name). */
  let current: string | undefined;
  /** First operation refused while preparing the current statement, for the error message. */
  let refused: string | undefined;

  const owned = (name: string | null): boolean => {
    if (!name) return false;
    const n = name.toLowerCase();
    return n.startsWith(prefix) || n.startsWith("sqlite_") || (internal && n === SCHEMA_TABLE);
  };
  const deny = (what: string): number => {
    refused ??= what;
    return C.SQLITE_DENY;
  };
  const check = (action: string, ...names: (string | null)[]): number => {
    for (const n of names) if (!owned(n)) return deny(`${action} ${n ?? "(unnamed)"}`);
    return C.SQLITE_OK;
  };

  raw.setAuthorizer((code, arg1, arg2) => {
    switch (code) {
      case C.SQLITE_SELECT:
      case C.SQLITE_FUNCTION:
      case C.SQLITE_RECURSIVE:
      case C.SQLITE_TRANSACTION:
      case C.SQLITE_SAVEPOINT:
        return C.SQLITE_OK;
      case C.SQLITE_READ: return check("read", arg1);
      case C.SQLITE_INSERT: return check("insert into", arg1);
      case C.SQLITE_UPDATE: return check("update", arg1);
      case C.SQLITE_DELETE: return check("delete from", arg1);
      case C.SQLITE_CREATE_TABLE:
      case C.SQLITE_CREATE_TEMP_TABLE: return check("create table", arg1);
      case C.SQLITE_DROP_TABLE:
      case C.SQLITE_DROP_TEMP_TABLE: return check("drop table", arg1);
      case C.SQLITE_CREATE_VIEW:
      case C.SQLITE_CREATE_TEMP_VIEW: return check("create view", arg1);
      case C.SQLITE_DROP_VIEW:
      case C.SQLITE_DROP_TEMP_VIEW: return check("drop view", arg1);
      // arg2 is the virtual table module (fts5, ...), not a schema object.
      case C.SQLITE_CREATE_VTABLE: return check("create virtual table", arg1);
      case C.SQLITE_DROP_VTABLE: return check("drop virtual table", arg1);
      // arg1 is the index or trigger, arg2 the table it belongs to.
      case C.SQLITE_CREATE_INDEX:
      case C.SQLITE_CREATE_TEMP_INDEX: return check("create index", arg1, arg2);
      case C.SQLITE_DROP_INDEX:
      case C.SQLITE_DROP_TEMP_INDEX: return check("drop index", arg1, arg2);
      case C.SQLITE_CREATE_TRIGGER:
      case C.SQLITE_CREATE_TEMP_TRIGGER: return check("create trigger", arg1, arg2);
      case C.SQLITE_DROP_TRIGGER:
      case C.SQLITE_DROP_TEMP_TRIGGER: return check("drop trigger", arg1, arg2);
      case C.SQLITE_REINDEX: return check("reindex", arg1);
      case C.SQLITE_ANALYZE: return check("analyze", arg1);
      // arg1 is the database, arg2 the table.
      case C.SQLITE_ALTER_TABLE: {
        if (check("alter table", arg2) !== C.SQLITE_OK) return C.SQLITE_DENY;
        for (const to of renameTargets(current ?? "")) if (!owned(to)) return deny(`rename table to ${to}`);
        return C.SQLITE_OK;
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
    try {
      return run();
    } catch (e) {
      if (refused !== undefined || (e as { errcode?: number }).errcode === 23) {
        throw new Error(`module ${moduleId}: database access refused: ${refused ?? "not authorized"} (a module may only use ${prefix}* tables, and no pragmas or attached databases)`, { cause: e });
      }
      throw e;
    } finally {
      current = undefined;
    }
  };

  let savepoints = 0;
  const db: ModuleDb = {
    prepare: (sql) => guarded(sql, () => raw.prepare(sql)),
    exec: (sql) => guarded(sql, () => raw.exec(sql)),
    transaction<T>(fn: () => T): T {
      const savepoint = raw.isTransaction ? `friday_sp_${++savepoints}` : undefined;
      raw.exec(savepoint ? `SAVEPOINT ${savepoint}` : "BEGIN IMMEDIATE");
      const rollback = () => raw.exec(savepoint ? `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}` : "ROLLBACK");
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
        raw.exec(savepoint ? `RELEASE ${savepoint}` : "COMMIT");
      } catch (e) {
        if (raw.isTransaction) rollback();
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
            if (typeof m.up === "string") db.exec(m.up);
            else m.up(db);
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

/** Table names after `RENAME TO` in `sql` (quoted or bare). `RENAME [COLUMN] a TO b` renames a column and is not matched. */
function renameTargets(sql: string): string[] {
  const out: string[] = [];
  for (const m of sql.matchAll(/\bRENAME\s+TO\s+(?:"((?:[^"]|"")+)"|`([^`]+)`|\[([^\]]+)\]|'((?:[^']|'')+)'|([\w$]+))/gi)) {
    out.push((m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5]).replace(/""|''/g, (q) => q[0]));
  }
  return out;
}

function isThenable(v: unknown): v is PromiseLike<unknown> {
  return (typeof v === "object" || typeof v === "function") && v !== null && typeof (v as { then?: unknown }).then === "function";
}
