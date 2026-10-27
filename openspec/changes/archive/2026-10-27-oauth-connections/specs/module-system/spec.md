# Spec Delta

## MODIFIED Requirements

### Requirement: Module contract

A module SHALL be an object with a `manifest` and an `init(ctx)` function, optionally a `dispose()` function, and optionally a list of `migrations` as specified in `module-database`. The manifest SHALL have a kebab-case `id` unique within a deployment, a `label`, an optional `description`, an optional list of `config` keys, each with `key`, optional `required`, optional `description` and optional `secret` (true for credentials and tokens; such values are stored encrypted and never shown in the portal), and an optional list of `oauth` requests as specified in `oauth-connections`, each with a kebab-case `provider`, `scopes` (a list of strings, possibly empty), an optional `description`, and optional `authUrl` and `tokenUrl`. A request SHALL carry both URLs or neither, they SHALL be `https`, and a manifest SHALL NOT request the same provider twice; a manifest that breaks these rules SHALL fail validation. `init` MAY be async and SHALL receive a `ModuleContext` exposing `defineTool`, `config.get`, `config.require` and `log`.

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

#### Scenario: Module requesting OAuth access
- **WHEN** a manifest declares `oauth: [{ provider: "spotify", scopes: ["playlist-read-private"], description: "Read your playlists" }]`
- **THEN** the manifest is valid and the module loads whether or not Spotify is connected or granted

#### Scenario: Invalid OAuth request
- **WHEN** a manifest declares an `oauth` request with an `authUrl` but no `tokenUrl`
- **THEN** the module fails to load with an error naming the module and the provider

## ADDED Requirements

### Requirement: OAuth tokens in the context

`ModuleContext` SHALL include `oauth` for in-process modules. `ctx.oauth.token(provider)` SHALL resolve to an access token or reject as specified in `oauth-connections`, checked on every call, so connecting, granting and revoking apply without a reload. The `OAuthError` type and its kinds (`not_connected`, `not_granted`, `refresh_failed`) SHALL be exported from `@friday/sdk`. Hosts without connections, such as the remote runner, SHALL make `ctx.oauth.token` reject with kind `not_connected` and a message stating that OAuth connections are not available in that host.

#### Scenario: Branch on the error kind
- **WHEN** a module catches a rejection from `ctx.oauth.token`
- **THEN** it can test the error with the SDK's exported type and read its `kind`

#### Scenario: Remote host
- **WHEN** a module run by `runRemote` calls `ctx.oauth.token("spotify")`
- **THEN** the call rejects with `not_connected` stating that OAuth connections are not available in this host

### Requirement: Test host fakes OAuth tokens

`createTestHost` SHALL accept an `oauth` option mapping a provider id to a token string, an `OAuthError`, or a function returning either, called on every `ctx.oauth.token` call. The test host SHALL reject a call for a provider the manifest does not request with `not_granted`, as core does, and a call for a requested provider missing from the option with `not_connected`. It SHALL count the calls per provider.

#### Scenario: Fake token
- **WHEN** a test creates a host with `oauth: { spotify: "t0ken" }` and calls a tool that uses the token
- **THEN** the module receives `t0ken`

#### Scenario: Fake error
- **WHEN** the option maps `spotify` to `new OAuthError("not_granted", "...")`
- **THEN** the module's `ctx.oauth.token("spotify")` rejects with that error

#### Scenario: Undeclared provider
- **WHEN** a module that requests only `spotify` calls `ctx.oauth.token("github")` in the test host
- **THEN** the call rejects with `not_granted`
