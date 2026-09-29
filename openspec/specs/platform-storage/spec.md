# Platform Storage

## Purpose

Core-owned persistent storage: a SQLite database in the data directory with versioned migrations, used by platform features and exposed to in-process modules as a per-module key-value namespace.

## Requirements

### Requirement: Database location and migrations

Core SHALL open `friday.db` in `FRIDAY_DATA_DIR` (default `./data`, created if missing) using `node:sqlite`, run pending numbered migrations inside a transaction at startup, and record the applied version. A failed migration SHALL abort startup with the migration name.

#### Scenario: Fresh start
- **WHEN** the data directory is empty
- **THEN** the database is created, all migrations run, and the server starts

#### Scenario: Upgrade
- **WHEN** the database is at version 1 and version 2 exists
- **THEN** only migration 2 runs and the version becomes 2

### Requirement: Per-module storage namespace

`ctx.storage` SHALL offer `get(key)`, `set(key, value)`, `delete(key)` and `list(prefix?)` over JSON-serialized values, isolated by module id. Remote modules SHALL NOT receive `storage`.

#### Scenario: Isolation
- **WHEN** modules `a` and `b` both set `last`
- **THEN** each reads back its own value

#### Scenario: Round-trip
- **WHEN** a module sets `{ n: 1 }` and restarts
- **THEN** `get` returns `{ n: 1 }` after restart

### Requirement: Data directory in the deployment

The k8s manifest SHALL mount a PersistentVolumeClaim at `/data` and set `FRIDAY_DATA_DIR=/data`.

#### Scenario: Pod restart
- **WHEN** the pod is recreated
- **THEN** stored configuration and keys are still present

### Requirement: Module tables live in the core database

Tables that in-process modules create through their migrations (as specified in `module-database`) SHALL be stored in `friday.db`, next to core's tables and `module_kv`. For each module that has run migrations, `friday.db` SHALL record the module id, its current schema version and when it last changed. That record SHALL survive restarts and reloads. Module tables and records SHALL NOT be deleted when a module is disabled or removed from the module list.

#### Scenario: Pod restart
- **WHEN** module `brain` has run migrations 1 and 2 and the pod is recreated
- **THEN** its tables and rows are still present, and on startup no migration runs for `brain`

#### Scenario: Module disabled
- **WHEN** `FRIDAY_MODULES` no longer includes `brain`
- **THEN** its tables and schema version stay in `friday.db`, and enabling it again resumes from that version
