# Spec Delta

## MODIFIED Requirements

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
