# Module System

## Purpose

Defines the contract a Friday module implements and how core hosts in-process modules: discovery from a fixed list, initialization with a per-module context, declared configuration, failure isolation, and a test host that lets a module be exercised without booting the server.

## Requirements

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

### Requirement: Tools defined through the context are owned by the module

`ctx.defineTool(tool)` SHALL register the tool in core's registry with the module's `id` as owner and return the tool. Tool names SHALL NOT be prefixed for in-process modules.

#### Scenario: Owner recorded
- **WHEN** module `media` defines `search_library`
- **THEN** the registry lists `search_library` with owner `media`

#### Scenario: Name collision across modules
- **WHEN** two in-process modules define the same tool name
- **THEN** the second module fails to load with `duplicate tool <name>` and the first module's tools remain registered

### Requirement: Declared configuration is validated and read through the context

The host SHALL check every `required` config key of a module before calling `init`. A missing required key SHALL fail that module with an error naming the module and the key. `ctx.config.get(key)` SHALL return the value resolved by the configuration store (module scope, then global scope, then process environment) or `undefined`; `ctx.config.require(key)` SHALL throw when the key is unset. Reads SHALL be lazy so values saved later are visible after a reload.

#### Scenario: Missing required key
- **WHEN** module `media` declares `JELLYFIN_URL` as required and it is unset
- **THEN** the module status is `failed` with an error mentioning `media` and `JELLYFIN_URL`, and other modules load normally

#### Scenario: Optional key
- **WHEN** a module reads an undeclared or optional key that is unset
- **THEN** `config.get` returns `undefined` and no error is raised at load time

#### Scenario: Stored value wins
- **WHEN** `JELLYFIN_URL` is both in the environment and stored for `media`
- **THEN** `config.get` returns the stored value

### Requirement: In-process modules are loaded from a fixed list, filtered by FRIDAY_MODULES

Core SHALL hold an explicit list of in-process modules. When `FRIDAY_MODULES` is set, only modules whose `id` is in that comma-separated list SHALL be loaded; ids that match no module SHALL be logged as warnings. When unset, all listed modules SHALL be loaded, in list order.

#### Scenario: Default
- **WHEN** `FRIDAY_MODULES` is unset
- **THEN** every module in the list is initialized in order

#### Scenario: Subset
- **WHEN** `FRIDAY_MODULES=builtin`
- **THEN** only `builtin` is initialized and `media` tools are absent from `/api/tools`

#### Scenario: Unknown id
- **WHEN** `FRIDAY_MODULES=builtin,nope`
- **THEN** `builtin` loads and a warning names `nope`

### Requirement: Module failures are isolated

An exception thrown by a module's `init` SHALL be logged with the module id, recorded as that module's status, and SHALL NOT prevent other modules from loading or the server from starting. Tools the failing module registered before throwing SHALL be removed.

#### Scenario: Init throws
- **WHEN** module `media` throws inside `init` after defining one tool
- **THEN** that tool is not in the registry, `media` reports `failed`, and `builtin` tools are available

### Requirement: Modules are disposed on shutdown

On shutdown the host SHALL call `dispose()` of each loaded module that defines it, in reverse load order, tolerating individual failures.

#### Scenario: Shutdown
- **WHEN** the process receives SIGTERM
- **THEN** every loaded module's `dispose` runs before the process exits

### Requirement: Module logging is prefixed

`ctx.log.*` SHALL prefix every line with `[<module id>]`.

#### Scenario: Log line
- **WHEN** module `media` calls `ctx.log.warn("slow")`
- **THEN** the output line starts with `[media]`

### Requirement: Test host for module packages

`@friday/sdk/test` SHALL export `createTestHost(module, options?)` that initializes the module against an in-memory registry with `options.env` as the configuration source and returns `{ tools, call(name, args), registry }` where `call` resolves to the registry's `callTool` result.

#### Scenario: Call a tool in isolation
- **WHEN** a module test creates a host with `env: { TZ: "Europe/Amsterdam" }` and calls `get_current_time`
- **THEN** it receives `{ result, scheduling }` without any HTTP server or Gemini connection

#### Scenario: Required config in tests
- **WHEN** a test host is created without a module's required key
- **THEN** `createTestHost` rejects with the same error the real host would log

### Requirement: A module runs unchanged in-process or remotely

A `FridayModule` SHALL be runnable by the in-process host and by `runRemote` without code changes. `ctx.defineTool`, `ctx.config` and `ctx.log` SHALL have the same semantics in both hosts, with `ctx.config` reading the remote process's environment.

#### Scenario: Same module, two hosts
- **WHEN** the builtin module is loaded in-process and also via `runRemote`
- **THEN** `get_current_time` is callable as `get_current_time` and as `builtin__get_current_time` with equal results

### Requirement: Module-scoped HTTP routes

`ctx.http.route(method, path, handler)` SHALL register a handler served at `/api/modules/<id>/<path>`, where `path` may contain `:param` segments. Handlers SHALL receive `(req, res, params)` with a JSON body helper. Routes SHALL be removed when the module is disposed or fails to load. Remote modules SHALL NOT have routes.

#### Scenario: Register a route
- **WHEN** media calls `ctx.http.route("GET", "search", handler)`
- **THEN** `GET /api/modules/media/search?q=x` invokes the handler

#### Scenario: Route with param
- **WHEN** media registers `GET items/:id`
- **THEN** `/api/modules/media/items/42` invokes it with `params.id === "42"`

#### Scenario: Module fails
- **WHEN** a module registered routes and then throws in `init`
- **THEN** its routes respond 404

### Requirement: Manifest declares UI presence

A manifest MAY set `ui: true` to indicate the module ships a portal UI; `/api/modules` SHALL expose it as `ui`.

#### Scenario: Listing
- **WHEN** media sets `ui: true`
- **THEN** `/api/modules` shows `"ui": true` for media

### Requirement: Modules can be reloaded individually

The host SHALL support `reload(id)` for in-process modules: dispose, remove tools, routes and prompt context providers, validate config, run pending migrations, initialize again. Failures during reload SHALL leave the module in `failed` status with the error.

#### Scenario: Reload
- **WHEN** `reload("media")` is called
- **THEN** `dispose` runs, then `init` runs, and the module reports `loaded`

#### Scenario: Providers are replaced on reload
- **WHEN** a module that registered one prompt context provider is reloaded and registers it again in `init`
- **THEN** exactly one provider of that module is rendered afterwards

### Requirement: Module storage in the context

`ModuleContext` SHALL include `storage` as specified in `platform-storage` for in-process modules. The test host SHALL provide an in-memory `storage`.

#### Scenario: Test host storage
- **WHEN** a module test sets and gets a storage key through `createTestHost`
- **THEN** the value round-trips without a database file

### Requirement: Text model in the context

`ModuleContext` SHALL include `llm` as specified in `module-llm`. Calls SHALL be attributed to the module id in usage logging. The error type and its kinds SHALL be exported from `@friday/sdk`, so modules can branch on `kind` without depending on core.

#### Scenario: Branch on the error kind
- **WHEN** a module catches a rejection from `ctx.llm.generate`
- **THEN** it can test the error with the SDK's exported type and read its `kind`

### Requirement: Test host fakes the text model

`createTestHost` SHALL accept an `llm` option: a function that receives each request and returns the model's raw text, or throws an SDK LLM error. The test host SHALL apply the same request checks and schema validation as core, so a fake answer that does not conform to the schema rejects with `invalid_output`. It SHALL record the requests it received. Without the option, `ctx.llm.generate` SHALL reject with `unavailable`.

#### Scenario: Fake answer is validated
- **WHEN** a test's fake returns `{"fact":"x"}` for a request whose schema requires `facts`
- **THEN** the module's call rejects with `invalid_output`, as it would against the real model

#### Scenario: Requests are observable
- **WHEN** a module under test makes two calls
- **THEN** the test host exposes both requests, including their system instruction and schema

#### Scenario: No fake configured
- **WHEN** a test host is created without `llm` and the module calls `ctx.llm.generate`
- **THEN** the call rejects with `unavailable`

### Requirement: Conversations in the context

`ModuleContext` SHALL include `conversations` for in-process modules, with read-only access to the conversation store:
- `list({ quietSince?, limit? })`: without `quietSince`, the most recently active conversations first. With `quietSince`, the conversations currently quiet that went quiet after that time, oldest first, so a consumer can advance a watermark.
- `get(id)`: one conversation with all its entries, or `undefined`.
- `search({ query?, since?, until?, channel?, device?, exclude?, limit? })`: the conversation store's search, with times as ISO 8601 instants, returning matched conversations with their snippets. An invalid query SHALL reject with an error stating what is invalid.
- `onQuiet(handler)`: subscribe to quiet notifications.

A handler that throws SHALL be logged with the module id and SHALL NOT affect other subscribers. Subscriptions SHALL be removed when the module is disposed or reloaded. Hosts without a conversation store, such as the remote runner, SHALL make these calls fail with an error stating that conversations are not available in that host. The test host SHALL provide an in-memory store that tests can seed with conversations, and on which tests can mark a conversation quiet to fire `onQuiet` handlers. Its `search` SHALL apply the same word, filter, ranking and snippet rules as the conversation store.

#### Scenario: Watermark processing
- **WHEN** a module calls `list({ quietSince: "2026-10-01T03:00:00Z" })`
- **THEN** it receives the conversations that went quiet after that time, oldest first

#### Scenario: Subscriptions follow the lifecycle
- **WHEN** a module with an `onQuiet` handler is reloaded
- **THEN** the old handler no longer fires and the handler registered by the new `init` does

#### Scenario: Test host
- **WHEN** a test seeds a conversation and marks it quiet
- **THEN** the module's `onQuiet` handler runs and `ctx.conversations.get(id)` returns the seeded entries

#### Scenario: Module searches conversations
- **WHEN** a module calls `search({ query: "boiler", since: "2026-09-15T00:00:00Z" })`
- **THEN** it receives the conversations mentioning "boiler" in entries since that time, best match first, with snippets

#### Scenario: Test host search
- **WHEN** a test seeds two conversations, only one mentioning "boiler", and the module calls `search({ query: "boiler" })`
- **THEN** only that conversation is returned, with a snippet around the matching entry

#### Scenario: Search in a remote host
- **WHEN** a module running through the remote runner calls `search`
- **THEN** the call fails with an error stating that conversations are not available in that host

### Requirement: Jobs in the context

`ModuleContext` SHALL include `jobs` for in-process modules. `ctx.jobs.schedule(job)` SHALL declare a job as specified in `background-jobs`, owned by the module id, and SHALL throw on an invalid declaration, so the module fails to load. `ctx.jobs.trigger(name)` SHALL start one of the module's own jobs on demand, and SHALL report whether a run started. When a module is disposed, reloaded, or fails during `init`, its jobs SHALL be removed and any in-progress run cancelled. A reloaded module's jobs SHALL keep their run history and catch-up state across the reload. Hosts without a scheduler, such as the remote runner, SHALL make `ctx.jobs.schedule` throw an error stating that jobs are not available in that host.

#### Scenario: Jobs follow the module lifecycle
- **WHEN** module `brain` with a scheduled job is reloaded
- **THEN** the old job's timers stop and any running run is cancelled, then the job is registered again and its history is intact

#### Scenario: Invalid job fails the module
- **WHEN** a module's `init` schedules a job with an invalid cron expression
- **THEN** the module reports `failed` with the job error, and none of its tools or jobs are registered

#### Scenario: Remote host
- **WHEN** a module run through `runRemote` calls `ctx.jobs.schedule`
- **THEN** it throws an error stating that jobs are not available in this host

### Requirement: Test host runs jobs directly

The test host SHALL record jobs a module schedules, without running any timers. It SHALL expose their names and schedules, and SHALL offer `runJob(name)`, which runs the handler once and resolves to the run's outcome, summary and error. Declarations SHALL be validated as the real host validates them.

#### Scenario: Run a job in a test
- **WHEN** a test calls `host.runJob("nightly")` on a module that schedules `nightly`
- **THEN** the handler runs once and the call resolves to `{ outcome: "ok" }`, with the handler's summary if it returned one

#### Scenario: Invalid schedule in tests
- **WHEN** a module schedules a job with an invalid cron expression under `createTestHost`
- **THEN** `createTestHost` rejects with the same error the real host would report

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

### Requirement: Household time zone helper

`@friday/sdk` SHALL export the household's default zone `Europe/Amsterdam`, a function that resolves a zone name to its canonical spelling (the one `Intl` reports, so names differing only in letter case are the same zone) when it is a valid IANA zone and to the default otherwise (reporting whether it was valid, with an unset or blank name counting as valid and resolving to the default), and a function `localDate(at, zone)` that returns the `YYYY-MM-DD` date of an instant in a zone. It SHALL also export a reader built from a module's `ctx.config` and a warning function, which returns the resolved zone of `FRIDAY_TIMEZONE` on every call, so a value saved later is picked up without a reload. The reader SHALL warn once per distinct invalid value, naming the value and the zone used instead, and SHALL warn again when the same invalid value returns after a valid one. It SHALL also export a date-time parser that takes a value and a zone and accepts only an ISO 8601 date-time (`YYYY-MM-DDTHH:mm[:ss[.fff]]`, `T` or a space) with an optional RFC 3339 offset (`Z` or `±HH:MM`) on a date that exists. It SHALL return the instant and the value as `YYYY-MM-DDTHH:mm:ss` plus an offset: the value's own offset when it has one, otherwise the zone's offset at that moment, with the value read as wall-clock time in that zone. Anything else (RFC 2822, `+0200`, 30 February) SHALL be rejected. The helper SHALL use only the platform's `Intl`, so in-process and remote modules can both use it.

#### Scenario: Valid zone
- **WHEN** `FRIDAY_TIMEZONE` is `Asia/Tokyo`
- **THEN** the reader returns `Asia/Tokyo` and warns nothing

#### Scenario: Unset zone
- **WHEN** `FRIDAY_TIMEZONE` is unset or blank
- **THEN** the reader returns `Europe/Amsterdam` and warns nothing

#### Scenario: Invalid zone warns once
- **WHEN** `FRIDAY_TIMEZONE` is `Mars/Olympus` and the reader is called three times
- **THEN** each call returns `Europe/Amsterdam` and exactly one warning names `Mars/Olympus` and `Europe/Amsterdam`

#### Scenario: Zone changed after init
- **WHEN** `FRIDAY_TIMEZONE` changes from `Europe/Amsterdam` to `America/New_York` between two calls
- **THEN** the second call returns `America/New_York`

#### Scenario: Local date across midnight
- **WHEN** `localDate` is called with `2026-09-28T23:30:00Z` and `Europe/Amsterdam`
- **THEN** it returns `2026-09-29`

#### Scenario: Letter case does not matter
- **WHEN** `FRIDAY_TIMEZONE` is `europe/amsterdam`
- **THEN** the reader returns `Europe/Amsterdam` and warns nothing

#### Scenario: Offset-less date-time read in the zone
- **WHEN** the parser is given `2026-10-08T15:00` and `Europe/Amsterdam`
- **THEN** it returns `2026-10-08T15:00:00+02:00` and the instant `2026-10-08T13:00:00Z`

#### Scenario: Own offset kept
- **WHEN** the parser is given `2026-10-08T15:00:00-05:00` and `Europe/Amsterdam`
- **THEN** it returns `2026-10-08T15:00:00-05:00`

#### Scenario: Not a date-time
- **WHEN** the parser is given `2026-02-30T10:00` or `Thu, 08 Oct 2026 15:00:00 +0200`
- **THEN** it rejects the value
