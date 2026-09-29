# Spec Delta

## Purpose

Lets in-process modules own relational tables in `friday.db`, with declared migrations, synchronous atomic transactions, and isolation that keeps each module inside its own namespace.

## ADDED Requirements

### Requirement: Modules declare numbered migrations

A module MAY declare `migrations`: a list of `{ version, name, up }`, where `version` is a positive integer unique within the module, `name` is non-empty, and `up` is either a SQL string or a function that receives the module's database handle. The host SHALL validate the whole list before running any migration. An invalid list SHALL fail the module with an error naming the module and the offending entry.

#### Scenario: Valid declaration
- **WHEN** module `brain` declares migrations `1 pages` and `2 revisions`
- **THEN** both are accepted and run in version order

#### Scenario: Duplicate version
- **WHEN** a module declares two migrations with version `2`
- **THEN** the module fails to load with an error naming the module and version `2`, and no migration runs

### Requirement: Pending migrations run before init

The host SHALL run a module's pending migrations after validating its configuration and before calling `init`, in ascending version order. Each migration SHALL run in its own transaction together with recording the module's new schema version. A migration is pending when its version is higher than the version recorded for that module. A module without recorded versions SHALL run all its migrations. On reload, the host SHALL run any migrations that became pending, and none otherwise.

#### Scenario: First start
- **WHEN** module `brain` with migrations 1 and 2 loads against a database that has never seen it
- **THEN** migrations 1 and 2 run, the recorded version for `brain` is 2, and then `init` runs

#### Scenario: Upgrade
- **WHEN** the recorded version for `brain` is 1 and the module now declares migrations 1, 2 and 3
- **THEN** only 2 and 3 run and the recorded version becomes 3

#### Scenario: Nothing pending
- **WHEN** a module is reloaded without code changes
- **THEN** no migration runs and `init` runs

### Requirement: Migration failures fail only the module

A migration that throws SHALL be rolled back, including its version record. The module SHALL fail to load with an error naming the module, the migration version and its name. Migrations of the same module that ran before it SHALL stay applied. The server and other modules SHALL be unaffected. When the recorded version is higher than the highest version the module declares, the module SHALL fail to load with an error stating both versions, and no migration SHALL run.

#### Scenario: Broken migration
- **WHEN** migration 2 of `brain` contains invalid SQL
- **THEN** `brain` is `failed` with an error naming `brain`, version 2 and its name, the recorded version stays 1, and the server starts with the other modules

#### Scenario: Schema newer than the module
- **WHEN** the recorded version for `brain` is 3 and the running module declares migrations up to 2
- **THEN** `brain` fails to load with an error naming versions 3 and 2, and its tables are unchanged

### Requirement: Synchronous database handle with transactions

`ctx.db` SHALL give in-process modules synchronous access to `friday.db`: `prepare(sql)` returning a statement with `run`, `get`, `all` and `iterate`, `exec(sql)`, and `transaction(fn)`. `transaction(fn)` SHALL commit when `fn` returns and roll back and rethrow when `fn` throws. When `fn` returns a promise or thenable, the transaction SHALL be rolled back and `transaction` SHALL throw, stating that transaction bodies must be synchronous. Only writes made before the body's first `await` can be rolled back; code after it runs once the transaction has ended. A `transaction` call inside another SHALL be rolled back on its own when it throws, without ending the outer transaction. Transaction statements (`BEGIN`, `COMMIT`, `ROLLBACK`, `SAVEPOINT`, `RELEASE`) issued by the module through `prepare` or `exec`, including in migrations, SHALL be refused, so a module cannot hold a transaction open across an `await`. Foreign keys SHALL be enforced.

#### Scenario: Atomic multi-row write
- **WHEN** a module inserts a page and its first revision in one `transaction`, and the revision insert throws
- **THEN** neither row exists afterwards

#### Scenario: Async body
- **WHEN** a module calls `transaction(async () => { ... })`
- **THEN** the call throws, and nothing the body wrote before its first `await` is kept

#### Scenario: Nested rollback
- **WHEN** an inner `transaction` throws and the outer body catches the error and returns
- **THEN** the inner writes are undone and the outer writes are committed

#### Scenario: Manual transaction
- **WHEN** a module runs `ctx.db.exec("BEGIN")`
- **THEN** the statement is refused with an error that names the module and points to `transaction`

### Requirement: A module's tables are isolated by prefix

A module's schema objects (tables, indexes, triggers, views, virtual tables) SHALL be named with the module's prefix: its id with `-` replaced by `_`, followed by `__`. For example `brain__pages` or `media_x__cache`. Any statement prepared through `ctx.db` or run by a migration SHALL be refused when it reads, writes, creates, alters or drops a schema object outside that prefix, attaches or detaches a database, or runs a pragma. Renaming a table to a name outside the prefix counts as creating an object outside it. SQLite's own internal objects may be read; the shared ones (`sqlite_sequence`, `sqlite_stat*`) SHALL NOT be written by a module statement, only changed by SQLite as a side effect of the module's DDL on its own objects (planner statistics may also be deleted). A migration that leaves a new schema object outside the prefix SHALL fail and be rolled back. The refusal SHALL be an error that names the module. A module whose id contains `--` or ends in `-` SHALL fail to load when it declares migrations, and every `ctx.db` call it makes SHALL throw.

#### Scenario: Own tables
- **WHEN** module `brain` creates `brain__pages` in a migration and later inserts and selects rows through `ctx.db`
- **THEN** all statements succeed

#### Scenario: Core table
- **WHEN** module `brain` prepares `SELECT * FROM conversations` or `DELETE FROM config_values`
- **THEN** the statement is refused and those tables are unchanged

#### Scenario: Another module's table
- **WHEN** module `media` prepares a statement on `media_x__cache`, owned by module `media-x`
- **THEN** the statement is refused

#### Scenario: Unprefixed table in a migration
- **WHEN** a migration of `brain` runs `CREATE TABLE pages (...)`
- **THEN** the migration fails and the module is `failed`

#### Scenario: Full-text search table
- **WHEN** module `brain` creates the FTS5 table `brain__search` and queries it with `MATCH`
- **THEN** the table is created and the query succeeds

#### Scenario: Pragma
- **WHEN** a module runs `PRAGMA foreign_keys = OFF` through `ctx.db`
- **THEN** the statement is refused and foreign keys stay enforced

### Requirement: The database is available only in-process

`ctx.db` SHALL be available to in-process modules only. In hosts without the database, such as the remote runner, every `ctx.db` call SHALL throw an error stating that the database is not available in that host. A remote module that declares migrations SHALL have them ignored, and the ignored migrations SHALL be logged.

#### Scenario: Remote module
- **WHEN** a module run through `runRemote` calls `ctx.db.prepare(...)`
- **THEN** the call throws an error stating that the database is not available in this host
