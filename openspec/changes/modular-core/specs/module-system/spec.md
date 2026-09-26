# Spec Delta

## Purpose

Defines the contract a Friday module implements and how core hosts in-process modules: discovery from a fixed list, initialization with a per-module context, declared configuration, failure isolation, and a test host that lets a module be exercised without booting the server.

## ADDED Requirements

### Requirement: Module contract

A module SHALL be an object with a `manifest` and an `init(ctx)` function, optionally a `dispose()` function. The manifest SHALL have a kebab-case `id` unique within a deployment, a `label`, an optional `description`, and an optional list of `config` keys, each with `key`, optional `required` and optional `description`. `init` MAY be async and SHALL receive a `ModuleContext` exposing `defineTool`, `config.get`, `config.require` and `log`.

#### Scenario: Minimal module
- **WHEN** a module exports `{ manifest: { id: "hello", label: "Hello" }, init(ctx) { ctx.defineTool(...) } }`
- **THEN** the host loads it and its tool appears in the registry owned by `hello`

#### Scenario: Module does not import core
- **WHEN** a module package is type-checked
- **THEN** it depends only on `@friday/sdk`, never on `@friday/core`

### Requirement: Tools defined through the context are owned by the module

`ctx.defineTool(tool)` SHALL register the tool in core's registry with the module's `id` as owner and return the tool. Tool names SHALL NOT be prefixed for in-process modules.

#### Scenario: Owner recorded
- **WHEN** module `media` defines `search_library`
- **THEN** the registry lists `search_library` with owner `media`

#### Scenario: Name collision across modules
- **WHEN** two in-process modules define the same tool name
- **THEN** the second module fails to load with `duplicate tool <name>` and the first module's tools remain registered

### Requirement: Declared configuration is validated and read through the context

The host SHALL check every `required` config key of a module before calling `init`. A missing required key SHALL fail that module with an error naming the module and the key. `ctx.config.get(key)` SHALL return the value from the process environment or `undefined`; `ctx.config.require(key)` SHALL throw when the key is unset.

#### Scenario: Missing required key
- **WHEN** module `media` declares `JELLYFIN_URL` as required and it is unset
- **THEN** the module status is `failed` with an error mentioning `media` and `JELLYFIN_URL`, and other modules load normally

#### Scenario: Optional key
- **WHEN** a module reads an undeclared or optional key that is unset
- **THEN** `config.get` returns `undefined` and no error is raised at load time

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
