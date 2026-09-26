# Spec Delta

## MODIFIED Requirements

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

## ADDED Requirements

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
