# Spec Delta

## MODIFIED Requirements

### Requirement: Module contract

A module SHALL be an object with a `manifest` and an `init(ctx)` function, optionally a `dispose()` function, and optionally a list of `migrations` as specified in `module-database`. The manifest SHALL have a kebab-case `id` unique within a deployment, a `label`, an optional `description`, and an optional list of `config` keys, each with `key`, optional `required`, optional `description` and optional `secret` (true for credentials and tokens; such values are stored encrypted and never shown in the portal). `init` MAY be async and SHALL receive a `ModuleContext` exposing `defineTool`, `config.get`, `config.require` and `log`.

#### Scenario: Minimal module
- **WHEN** a module exports `{ manifest: { id: "hello", label: "Hello" }, init(ctx) { ctx.defineTool(...) } }`
- **THEN** the host loads it and its tool appears in the registry owned by `hello`

#### Scenario: Module does not import core
- **WHEN** a module package is type-checked
- **THEN** it depends only on `@friday/sdk`, never on `@friday/core`

#### Scenario: Secret flag does not change retrieval
- **WHEN** a module declares `{ key: "HA_TOKEN", secret: true }` and calls `ctx.config.require("HA_TOKEN")`
- **THEN** it receives the value exactly as for a plain key

#### Scenario: Module with migrations
- **WHEN** a module exports `{ manifest, migrations: [{ version: 1, name: "pages", up: "CREATE TABLE ..." }], init }`
- **THEN** the host runs the migration before `init`

### Requirement: Modules can be reloaded individually

The host SHALL support `reload(id)` for in-process modules: dispose, remove tools, routes and prompt context providers, validate config, run pending migrations, initialize again. Failures during reload SHALL leave the module in `failed` status with the error.

#### Scenario: Reload
- **WHEN** `reload("media")` is called
- **THEN** `dispose` runs, then `init` runs, and the module reports `loaded`

#### Scenario: Providers are replaced on reload
- **WHEN** a module that registered one prompt context provider is reloaded and registers it again in `init`
- **THEN** exactly one provider of that module is rendered afterwards

## ADDED Requirements

### Requirement: Database in the context

`ModuleContext` SHALL include `db` as specified in `module-database` for in-process modules. The host SHALL open a module's database access on first use and keep it across reloads.

#### Scenario: Query in init
- **WHEN** a module whose migrations created `hello__items` selects from it in `init`
- **THEN** the query returns the table's rows

### Requirement: Prompt context in the context

`ModuleContext` SHALL include `prompt` for in-process modules. `ctx.prompt.addContext(provider)` SHALL register a synchronous function that receives `{ channel }` (`voice` or `chat`) and returns text or `undefined`. It SHALL return a function that removes the provider. Whenever core builds a system prompt for a channel, it SHALL call every registered provider and render the module context:
- providers are called in module load order, and a module's providers in registration order;
- each non-empty result is trimmed and separated from the next by a blank line;
- empty and `undefined` results are skipped;
- a module's combined contribution longer than `FRIDAY_PROMPT_CONTEXT_MAX_CHARS` (default 12000) is cut to that length, marked with `…`, and a warning naming the module is logged;
- a provider that throws is skipped, and the error is logged with the module id;
- a provider taking longer than 100 ms is logged with its duration.

A module's providers SHALL be removed when it is disposed, reloaded or fails during `init`. Hosts without prompt assembly, such as the remote runner, SHALL make `ctx.prompt.addContext` throw an error stating that prompt context is not available in that host.

#### Scenario: Two modules contribute
- **WHEN** modules `brain` and `media`, loaded in that order, each register a provider returning a paragraph
- **THEN** the rendered module context is the `brain` paragraph, a blank line, then the `media` paragraph

#### Scenario: Channel-specific context
- **WHEN** a provider returns text only when `channel` is `chat`
- **THEN** the chat prompt contains that text and the voice prompt does not

#### Scenario: Failing provider
- **WHEN** a provider throws while a voice session opens
- **THEN** the session opens with the other modules' context, and the error is logged with the module id

#### Scenario: Oversized context
- **WHEN** a module's provider returns 20000 characters with the default cap
- **THEN** 12000 characters of it are rendered, ending in `…`, and a warning names the module

#### Scenario: Failed module
- **WHEN** a module registers a provider and then throws in `init`
- **THEN** its provider is never called

### Requirement: Test host provides a database and renders prompt context

`createTestHost` SHALL run the module's migrations against an in-memory database before `init`, with the validation, failure and isolation rules of `module-database`, so a failing or non-isolated migration rejects `createTestHost` with the error the real host would record. The test host SHALL expose the handle as `db`, and SHALL offer `promptContext(channel)` that renders the module's providers with the rules of the real host.

#### Scenario: Seed and inspect
- **WHEN** a module test creates a host for a module with migrations and inserts a row through `host.db`
- **THEN** the module sees the row through `ctx.db`, and no database file is created

#### Scenario: Prompt context in tests
- **WHEN** a test calls `host.promptContext("voice")` for a module that registered a provider
- **THEN** it receives the provider's rendered output for `voice`
