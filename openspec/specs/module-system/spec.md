# Module System

## Purpose

Defines the contract a Friday module implements and how core hosts in-process modules: discovery from a fixed list, initialization with a per-module context, declared configuration, failure isolation, and a test host that lets a module be exercised without booting the server.

## Requirements

### Requirement: Module contract

A module SHALL be an object with a `manifest` and an `init(ctx)` function, optionally a `dispose()` function. The manifest SHALL have a kebab-case `id` unique within a deployment, a `label`, an optional `description`, and an optional list of `config` keys, each with `key`, optional `required`, optional `description` and optional `secret` (true for credentials and tokens; such values are stored encrypted and never shown in the portal). `init` MAY be async and SHALL receive a `ModuleContext` exposing `defineTool`, `config.get`, `config.require` and `log`.

#### Scenario: Minimal module
- **WHEN** a module exports `{ manifest: { id: "hello", label: "Hello" }, init(ctx) { ctx.defineTool(...) } }`
- **THEN** the host loads it and its tool appears in the registry owned by `hello`

#### Scenario: Module does not import core
- **WHEN** a module package is type-checked
- **THEN** it depends only on `@friday/sdk`, never on `@friday/core`

#### Scenario: Secret flag does not change retrieval
- **WHEN** a module declares `{ key: "HA_TOKEN", secret: true }` and calls `ctx.config.require("HA_TOKEN")`
- **THEN** it receives the value exactly as for a plain key

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

The host SHALL support `reload(id)` for in-process modules: dispose, remove tools and routes, validate config, initialize again. Failures during reload SHALL leave the module in `failed` status with the error.

#### Scenario: Reload
- **WHEN** `reload("media")` is called
- **THEN** `dispose` runs, then `init` runs, and the module reports `loaded`

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
