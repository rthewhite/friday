# Proposal

## Why

The brain module, and modules after it, need relational storage with real transactions. That means pages, revisions and tombstones that change together, and it can't be done on the key-value `ctx.storage`: that interface is async and not transactional, so a write that touches several keys can end up half-applied. jarvis's first nightly consolidation failed exactly that way. The brain also has to prime Friday with what it knows, and today the voice and chat system prompts are fixed strings that no module can add to.

## What Changes

- New **module-owned tables**. A module MAY declare numbered `migrations` in its definition. The host runs pending ones before `init`, each in its own transaction, and records the applied version per module in `friday.db`.
- New **`ctx.db`** for in-process modules: a **synchronous** handle over `friday.db` offering prepared statements, `exec`, and `transaction(fn)`. It is synchronous on purpose. On one Node thread, a synchronous transaction can't interleave with other writes to the database; an async one could.
- **Enforced table isolation.** A module's tables, indexes, triggers and views are named `<prefix>__*`, where the prefix is the module id with `-` mapped to `_` (`brain__pages`, `media_x__cache`). The double underscore keeps one module's namespace from covering another's.
  - Any statement through `ctx.db` that touches another schema object, attaches a database or runs a pragma is refused when it is prepared. That includes core's tables and other modules' tables.
  - This applies to migrations and to runtime queries alike.
- **A failed migration fails that module** with the migration's name, and the server still starts. The same happens when the database holds a newer module schema version than the module declares, for example after rolling back to an older image. Core's own migrations keep aborting startup.
- **Test host:** `createTestHost` runs the module's migrations against an in-memory database with the same isolation checks, and exposes the handle to tests. **Remote host:** `ctx.db` fails with a clear error, as `jobs` and `conversations` do.
- New **prompt context providers**. `ctx.prompt.addContext(provider)` registers a synchronous function that receives the channel (`voice` or `chat`). Core calls every provider whenever it builds a system prompt: when a voice session opens, and when a chat turn starts.
  - The output is appended after the channel's prompt, in module load order.
  - Each module's contribution is capped in size.
  - A provider that throws or returns nothing is skipped, and a throw is logged.
  - Providers are removed when their module is disposed, reloaded or fails.
  - Remote modules can't register providers.

Out of scope: reading or joining other modules' or core's tables, deleting a module's tables when it is removed, down-migrations, and async providers or providers that fetch remote data.

## Capabilities

### New Capabilities
- `module-database`: module migrations and their version tracking, the synchronous `ctx.db` handle with transactions, table-prefix isolation, and migration failure semantics.

### Modified Capabilities
- `module-system`:
  - The module contract gains optional `migrations`. `ModuleContext` gains `db` and `prompt`.
  - The test host provides an in-memory database and renders prompt context.
  - Remote hosts reject `ctx.db` and `ctx.prompt`.
  - Reload and failure also drop prompt providers.
- `platform-storage`: module tables and the per-module schema versions live in `friday.db` next to `module_kv`.
- `voice-session`: the voice system prompt is the base and voice parts followed by the module context for channel `voice`, evaluated when the session opens.
- `portal-chat`: the chat system prompt is the base and chat parts followed by the module context for channel `chat`, evaluated when each turn starts.

## Impact

- **SDK**:
  - `packages/sdk/src/{module,context,test}.ts` gain `migrations`, `ctx.db` and `ctx.prompt`.
  - A new `db.ts` holds the handle type, the prefix authorizer and the migration runner. These are shared by core and the test host so both apply the same checks. It is imported only by hosts, never by `@friday/sdk/remote`.
- **Core**:
  - `module-host.ts` opens one connection per module with a database, runs migrations before `init`, wires `db` and `prompt`, drops providers on teardown, and closes the connections at shutdown.
  - A new prompt-context registry renders providers per channel.
  - `session.ts` / `transports/ws.ts` and `chat/engine.ts` build their system instruction from the channel prompt plus that rendering.
  - `server.ts` handles wiring and shutdown order.
- **Runtime**: requires Node 24 with `DatabaseSync#setAuthorizer`. The image uses `node:24-alpine` and CI uses Node 24.
- **Docs**: README (modules section), `.env.example` if the context cap becomes configurable, and the `openspec/config.yaml` context (`ctx.db`, `ctx.prompt`).
- **Consumers**: `brain` (next change) is the first user.
