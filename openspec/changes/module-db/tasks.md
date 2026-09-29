# Tasks

## 1. SDK database handle and isolation

- [x] 1.1 Add `packages/sdk/src/db.ts` with prefix derivation (`brain` → `brain__`, `media-x` → `media_x__`, rejecting ids with `--` or a trailing `-`) and the `ModuleDb` type (`prepare`, `exec`, `transaction`). Export the type (type only) from `@friday/sdk`. Verify with unit tests in `packages/sdk/test/db.test.ts` for prefix derivation and the rejected ids
- [x] 1.2 Implement `openModuleDb(location, moduleId)`:
  - set `foreign_keys = ON` and `busy_timeout`, then install the prefix authorizer (own prefix and `sqlite_*` allowed; `data_version` pragma allowed; `ATTACH`/`DETACH`, other pragmas and foreign objects denied);
  - rethrow refusals with the module id.

  Verify with `db.test.ts` cases for own-table CRUD, `SELECT` on and `DELETE` from a core table refused, another module's prefixed table refused, `PRAGMA foreign_keys = OFF` refused, `ATTACH` refused, and an FTS5 table created and queried with `MATCH`
- [x] 1.3 Implement `transaction(fn)` (`BEGIN IMMEDIATE`, commit/rollback-rethrow, thenable result → rollback and throw, nested calls as `SAVEPOINT`s). Verify with `db.test.ts` cases for atomic multi-row rollback, an async body, and an inner rollback that keeps the outer commit

## 2. SDK migrations and context

- [x] 2.1 Add `migrations` to `FridayModule` and implement the runner in `db.ts`:
  - validate the full list first;
  - create `module_schema` if missing;
  - run pending migrations in version order, each in one transaction with its version row, through the host-internal flag for `module_schema`;
  - on failure, fail with the module id, version and name, keeping earlier migrations;
  - when the recorded version is newer than the highest declared one, fail with both versions.

  Verify with `db.test.ts` cases for first start, upgrade (only pending run), nothing pending, duplicate version, broken SQL (recorded version unchanged), unprefixed `CREATE TABLE` refused, and schema newer than the module
- [x] 2.2 Add `db` and `prompt` to `ModuleContext`, `ContextOptions` and `createContext`, with stubs that throw `<id>: database is not available in this host` and `<id>: prompt context is not available in this host`. Make `runRemote` log and ignore declared migrations. Verify with a `remote-runner.test.ts` case: a module with migrations runs remotely, and `ctx.db.prepare` and `ctx.prompt.addContext` throw those messages
- [x] 2.3 Implement prompt context rendering in the SDK, shared by core and the test host:
  - registration order within a module, trimmed blocks joined by a blank line, empty results skipped;
  - a per-module cap with `…` and a warning;
  - a throwing provider is logged and skipped;
  - a slow provider (over 100 ms) is logged with its duration;
  - `addContext` returns an unsubscribe function.

  Verify with unit tests in `packages/sdk/test/prompt.test.ts` for ordering, channel-specific output, cap and warning, a throwing provider, the slow-provider log (with an injected clock) and unsubscribe
- [x] 2.4 Extend `createTestHost`: run migrations on an in-memory database before `init` (rejecting with the real host's errors), expose `db`, and add `promptContext(channel)`. Verify with `test-host.test.ts` cases for seed-and-inspect through `host.db`, a failing migration rejecting `createTestHost`, and `promptContext("voice")` returning a provider's output
- [x] 2.5 Document `migrations`, `ctx.db` (synchronous, `transaction`, prefix rule, what is refused) and `ctx.prompt.addContext` in `packages/sdk/README.md` (Module, `ModuleContext` and Testing sections). Verify the README's migration-and-query example compiles by using it verbatim in `db.test.ts`

## 3. Core host and prompt wiring

- [ ] 3.1 In `ModuleHost`:
  - open a module's connection lazily on `friday.db` (`FRIDAY_DATA_DIR`), running migrations after config validation and before `init`;
  - pass `db` and a per-owner `prompt` into `createContext`;
  - remove a module's providers on teardown and failed `init`;
  - keep connections across reloads and close them in `dispose()`.

  Verify with `module-host.test.ts` / `reload.test.ts` cases for migrations before `init`, a broken migration leaving the module `failed` while others load, reload running only newly pending migrations, providers replaced (not duplicated) on reload, and a failed module's provider never rendered
- [ ] 3.2 Add a core prompt-context registry that renders all modules in load order for a channel, with `FRIDAY_PROMPT_CONTEXT_MAX_CHARS` (default 12000) in core `settings`. Verify with a unit test for two modules in load order and the default cap
- [ ] 3.3 Give `GeminiSession` a `systemPrompt: () => string` option evaluated in `open()`, and have `transports/ws.ts` pass the voice prompt plus the rendered `voice` context. Verify with `session.test.ts` cases (fake `connect`): the instruction is base + voice + module context, is unchanged when no provider returns text, and a second session picks up changed provider output
- [ ] 3.4 Change `ChatEngine`'s `system` to `() => string`, evaluated once per turn and reused for every model call of the turn, composed from the chat prompt plus the rendered `chat` context. Verify with `chat-engine.test.ts` cases: module context on every call of a tool-loop turn, and new provider output on the next turn
- [ ] 3.5 Wire the registry and database location in `server.ts`, and close module connections after `host.dispose()` and before `db.close()` on shutdown. Verify by starting core locally with a throwaway module (not committed) that declares a migration and a provider: the migration is logged once across two restarts, the voice and chat prompts contain its context (logged via a debug assertion in the throwaway module), and SIGTERM exits cleanly
- [ ] 3.6 Document `FRIDAY_PROMPT_CONTEXT_MAX_CHARS` in `.env.example`, module tables and prompt context in the README ("Add a module" and "Configuration, storage and keys"), and `ctx.db` / `ctx.prompt` in the `openspec/config.yaml` context. Verify the README's example module snippet type-checks when copied into a scratch module

## 4. Integration

- [ ] 4.1 Run `pnpm -r build && pnpm -r typecheck && pnpm -r test` in the worktree and verify all pass
- [ ] 4.2 Build the container image locally (`docker build .`) and run it with a throwaway module that declares a migration using FTS5. Verify the migration applies on `node:24-alpine` (authorizer available, FTS5 compiled in) and `/api/modules` reports the module `loaded`
