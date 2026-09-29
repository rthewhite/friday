# Design

## Context

See proposal.md for the motivation. The current state that shapes the approach:

- Core opens one `node:sqlite` `DatabaseSync` on `friday.db` (WAL, `foreign_keys = ON`) in `packages/core/src/storage/db.ts` and applies its own migrations at boot. Every core transaction (`conversations/store.ts`, `jobs/store.ts`, `tools/mcp-store.ts`) is a synchronous `BEGIN … COMMIT` that never spans an `await`.
- Modules get `ctx.storage` (async key-value over `module_kv`). Hosts build contexts through `createContext` in `packages/sdk/src/context.ts`. Missing facilities default to stubs that throw (`jobs`, `conversations`) or reject (`llm`), and the remote runner relies on those defaults.
- `ModuleHost` (`packages/core/src/module-host.ts`) calls `init`, and on failure or teardown removes the module's tools, routes, jobs and quiet subscriptions.
- The prompts are fixed strings: `settings.systemPrompt` (base + voice) is read in `GeminiSession.open()`, and `settings.chatPrompt` (base + chat) is passed to `ChatEngine` as `system` and sent on every model call of a turn.
- Node 24 (image `node:24-alpine`, CI `node-version: 24`) has `DatabaseSync#setAuthorizer`. A spike confirmed that a second connection to the same file with an authorizer can create and use prefixed tables, FTS5 included, and is refused reads, writes and DDL on other tables, as well as `ATTACH` and pragmas.

## Goals / Non-Goals

**Goals:**
- A module can own relational tables and change several rows atomically.
- A bug in one module can't read, change or drop core's or another module's data through `ctx.db`.
- Tests exercise the same migrations and isolation rules as production.
- Module prompt context reaches both voice and chat without the module knowing how prompts are assembled.

**Non-Goals:**
- Protecting against a malicious in-process module. It runs in the same process and could open the file itself. Isolation guards against mistakes, not attacks.
- Sharing data between modules through SQL. Cross-module access stays with the existing facades (`ctx.conversations`, …).
- A query builder or ORM. Modules write SQL.

## Decisions

### D1. `ctx.db` is synchronous, a thin wrapper over `node:sqlite`

`ctx.db` exposes `prepare(sql)` (returning node's `StatementSync`: `run`, `get`, `all`, `iterate`), `exec(sql)` and `transaction(fn)`.

- **Why synchronous:** a transaction whose body is synchronous can't interleave with any other statement in the process, so atomicity comes for free. An async API over one database would have to serialize transactions with a queue, and a module awaiting inside one would stall every other writer.
- **Rejected alternative:** mirroring `ctx.storage`'s async style. It looks consistent, but it either gives up real transactions or needs a global write lock.
- **`transaction(fn)`:**
  - Uses `BEGIN IMMEDIATE`, commits when `fn` returns, and rolls back and rethrows when it throws.
  - When `fn` returns a thenable, it rolls back and throws. An `await` inside a transaction is always a bug.
  - Nested calls use `SAVEPOINT`s, so store helpers can be composed inside a larger transaction.

### D2. One connection per module, isolated by an authorizer

Each module that uses `ctx.db` gets its own `DatabaseSync` on `friday.db`.

- The host sets `foreign_keys = ON` and a `busy_timeout` first, then installs an authorizer that allows only operations on objects whose name starts with the module's prefix. Internal `sqlite_*` objects are also allowed, for reads, schema bookkeeping and auto-indexes. The pragma `data_version` is allowed because FTS5 issues it internally. `ATTACH`, `DETACH`, every other pragma, and any table, index, trigger or view outside the prefix are denied.
- A denied statement throws when it is prepared, with SQLite's "not authorized" / "access to X is prohibited" message. The wrapper rethrows that error with the module id.
- The connection opens lazily, on the first migration or the first `ctx.db` call, so modules that don't use it cost nothing. It is kept across reloads and closed at shutdown after modules are disposed.
- **Why a second connection:** an authorizer is per connection, and core's connection must stay unrestricted. The alternative of toggling an authorizer on the shared connection around each module call can't work, because the module holds statements across calls.
- **Contention:** two connections in one thread can only block each other if one holds a transaction across an `await`. Core never does, and D1 forbids modules from doing it. `busy_timeout` is a backstop and turns a violation into a visible error rather than a hang.
- **Rejected alternative:** convention plus a `sqlite_master` diff after migrations. It catches DDL outside the prefix at migration time, but not a runtime `DELETE FROM conversations`.

### D3. Prefix is `<id with - → _>__`

The prefix for `brain` is `brain__` and for `media-x` it is `media_x__`.

- A single underscore would let module `media`'s namespace `media_*` cover `media_x_*`.
- Module ids match `^[a-z][a-z0-9-]*$`. Only an id containing `--` or ending in `-` could produce a prefix that another module's prefix starts with. A module with such an id that declares migrations or uses `ctx.db` fails to load with a clear error.
- Existing ids (`builtin`, `media`, remote ids) are unaffected.

### D4. Migrations are declared on the module and run by a shared runner

`FridayModule.migrations?: { version: number; name: string; up: string | ((db) => void) }[]`.

- **Validation:** versions are positive integers, unique, and names are non-empty. The migrations are validated before any runs.
- **Where they run:** the host runs pending migrations after config validation and before `init`, on the module's connection. The prefix authorizer applies, so a migration can't touch core tables. Each migration runs in its own transaction together with recording its version, and a failure rolls back that migration only.
- **Where versions are recorded:** in a core-owned table `module_schema (module_id PRIMARY KEY, version, updated_at)`. The runner creates it with `CREATE TABLE IF NOT EXISTS` so the test host's in-memory database gets it too. That keeps one source for its DDL rather than a core migration plus a copy in the test host.
  - The runner's own statements go through the same module connection. The authorizer allows `module_schema` only while a host-internal flag is set around the runner's prepare and step. Modules never see the flag.
  - Re-prepares triggered by a schema change also happen inside the flagged window.
- **Newer schema:** a module whose recorded version is higher than its highest declared version fails to load (`database schema v3 is newer than module brain's migrations (v2)`) and nothing is touched. This protects data after an image rollback.
- **Why run before `init`:** `init` and anything it schedules can assume the schema is current.
- **Reload:** re-runs the check, which is a no-op unless the module's code changed.
- **Rejected alternative:** migrations inside `init` through `ctx.db.migrate(...)`. It is more flexible, but the host couldn't tell a failed migration from a failed `init`, and the test host couldn't validate declarations up front.

### D5. SDK owns the shared pieces; the remote entry stays free of `node:sqlite`

- `packages/sdk/src/db.ts` holds the `ModuleDb` type, prefix derivation, the authorizer, the transaction wrapper and the migration runner.
- Core's host and `@friday/sdk/test` use it. `createContext` accepts `db` and `prompt` like the other facilities, and defaults to stubs that throw `"<id>: database is not available in this host"` or `"<id>: prompt context is not available in this host"`.
- `@friday/sdk/remote` never imports `db.ts`, so the remote runner doesn't load `node:sqlite`. `runRemote` logs and ignores a module's `migrations`, so the same module package can still run remotely. Its `ctx.db` calls fail at use.
- The `ModuleDb` type is exported from `@friday/sdk` as a type only.

### D6. Prompt context: a registry of synchronous providers, rendered per channel

- **Registering:** `ctx.prompt.addContext(provider)`, where `provider: (info: { channel: "voice" | "chat" }) => string | undefined`. It returns an unsubscribe function.
- **Rendering:** core keeps providers per owner in load order. `render(channel)` calls each one inside a `try` and trims the result. Empty or `undefined` output is skipped. Output longer than the per-module cap is cut at the cap with a trailing `…`, and core logs a warning naming the module.
  - The cap is `FRIDAY_PROMPT_CONTEXT_MAX_CHARS`, default 12000. That leaves room for the brain's roughly 800-token profile plus a 50-entry index.
  - A provider that throws is logged with the module id and skipped.
  - A provider slower than 100 ms is logged with its duration. A synchronous provider can't be timed out, so logging makes the cost visible.
- **The final prompt:** `channel prompt + "\n\n" + blocks.join("\n\n")`. Modules supply their own heading. Core adds no wrapper, so a module fully controls how its context reads.
- **Voice:** `GeminiSession` takes a `systemPrompt: () => string` option, evaluated in `open()`. `transports/ws.ts` passes `() => compose(settings.systemPrompt, prompt.render("voice"))`.
- **Chat:** `ChatEngine` takes `system: () => string`, evaluated once when a turn starts and reused for every model call of that turn, so a tool loop sees a stable instruction.
- **Why synchronous:** it runs on the path that opens a voice session, where latency is audible. A synchronous read from SQLite takes microseconds. An async provider would invite network calls on that path.
- **Why the channel is passed:** a module may want less context for voice than for chat, for example a shorter index.
- **Teardown:** the host removes a module's providers on teardown and failed `init`, like quiet subscriptions.
- **Test host:** records providers and exposes `promptContext(channel)`, which renders them with the same rules.
- **Rejected alternative:** providers that return structured data rendered by core. That is more rigid and adds nothing a heading can't do.

## Risks / Trade-offs

- **[Risk]** A module's long-running synchronous query blocks the event loop, including audio. → Keep queries small (household-scale data). The provider timing log surfaces slow context. It is the same trade-off core's own stores already make.
- **[Risk]** The authorizer denies something SQLite does internally for a feature a future module needs (another pragma, virtual table modules). → The error names the denied operation. The allow-list lives in one place in `db.ts`, and extending it is a small change. A test covers FTS5 because the brain may want it.
- **[Risk]** `sqlite_sequence` is shared by every `AUTOINCREMENT` table. A module could read or reset another table's counter. → Accepted, since the non-goal is malicious modules. Module tables should prefer `INTEGER PRIMARY KEY` or text ids.
- **[Risk]** A Node version without `setAuthorizer` fails at runtime. → Startup checks for it and fails the affected modules with a message naming the requirement. It doesn't crash core. The image and CI already use Node 24.
- **[Trade-off]** Modules' tables stay in `friday.db` after the module is removed. → Accepted, since dropping them is out of scope. The rows in `module_schema` show which modules own what.
- **[Trade-off]** Chat turns re-render module context each turn, so a thread's system prompt can change between turns and Gemini's implicit caching benefits less. → Accepted: fresh memory matters more than cache hits at this volume.

## Migration Plan

- There is no core schema migration. `module_schema` is created on first use.
- Deploying is a normal image rollout. Existing modules declare no migrations, so nothing changes until `brain` ships.
- **Rollback:** an older image ignores `module_schema` and module tables. Rolling forward again resumes where it was. A module rolled back to fewer migrations fails to load with the newer-schema error instead of corrupting data.

## Open Questions

- Whether to expose `module_schema` in `/api/modules` (for example `schemaVersion`). It is harmless to add later and not needed by `brain`.
