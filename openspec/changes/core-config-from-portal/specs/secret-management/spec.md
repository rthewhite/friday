# Spec Delta

## ADDED Requirements

### Requirement: Core declares its own configuration

Core SHALL declare its own configuration keys as the requester `core`, in the same shape as a module's `config` entries. It SHALL declare `GEMINI_API_KEY` as secret and required. Core SHALL resolve its keys from the `core` scope, then the `global` scope, then the process environment, and SHALL read them at each use, so a stored value applies to the next voice session and the next text-generation call without a restart. A missing required core key SHALL NOT stop core from starting: startup SHALL log a warning naming the key, and features that need it SHALL fail as they do today without a key. `FRIDAY_MASTER_KEY` SHALL be read from the environment only.

#### Scenario: Key saved in the portal
- **WHEN** `GEMINI_API_KEY` is only in the environment and the user saves a different value for scope `core`
- **THEN** the next voice session and the next `ctx.llm` call use the saved value, without a restart

#### Scenario: Environment fallback
- **WHEN** no `GEMINI_API_KEY` is stored in scope `core` or `global`
- **THEN** core uses the environment value, and the configuration listing reports status `env`

#### Scenario: No key anywhere
- **WHEN** `GEMINI_API_KEY` is neither stored nor in the environment
- **THEN** core starts, logs a warning naming `GEMINI_API_KEY`, and the listing reports it `pending`

#### Scenario: Core key in the drawer
- **WHEN** the user opens `GEMINI_API_KEY` on the Secrets tab
- **THEN** the scope selector offers `core` and `global`, the drawer offers `Save` and `Clear` but no reload action, and states that the value applies to the next session

## MODIFIED Requirements

### Requirement: Resolution order

`ctx.config.get(key)` SHALL resolve module scope, then `global` scope, then the process environment. Values SHALL be read lazily so a reloaded module observes new values. Core's own keys SHALL resolve the same way, with `core` in place of the module scope.

#### Scenario: Module overrides global
- **WHEN** `HA_URL` is set globally and also for `media`
- **THEN** media reads its own value and other modules read the global one

#### Scenario: Env fallback
- **WHEN** a key is not stored but present in the environment
- **THEN** `config.get` returns the environment value and the API reports status `env`

#### Scenario: Core scope overrides global
- **WHEN** `GEMINI_API_KEY` is stored both globally and for `core`
- **THEN** core uses the value stored for `core`

### Requirement: Configuration API

`GET /api/config` SHALL return `{ secretsEnabled, entries }` with one entry per key: `key`, `secret`, `required` (true when any requester requires it), `description`, `modules` (array of `{ id, required }` of the requesters declaring the key, which are modules and `core`; empty for undeclared globals), `status` (`set`, `pending`, `env`), `scope`, `updatedAt` for stored values, and `value` for plain entries with a stored or environment value. Secret entries SHALL never include a value. `PUT /api/config/:scope/:key` with `{ value, secret? }` SHALL store a value; `DELETE` SHALL remove it. Scope SHALL be a loaded module id, `core`, or `global`.

#### Scenario: Listing
- **WHEN** media declares `JELLYFIN_URL` (plain, stored) and `JELLYFIN_API_KEY` (secret, stored)
- **THEN** the URL entry has `secret: false`, `modules: [{ id: "media", required: true }]`, its `value` and `updatedAt`; the key entry has `secret: true`, status `set`, and no `value`

#### Scenario: Shared key appears once
- **WHEN** two modules declare `HA_URL`
- **THEN** the listing has one `HA_URL` entry whose `modules` lists both

#### Scenario: Env plain value is visible
- **WHEN** `HA_URL` is plain and comes from the environment
- **THEN** its entry has status `env` and includes the environment value

#### Scenario: Core's key is listed
- **WHEN** the configuration is listed
- **THEN** `GEMINI_API_KEY` appears with `secret: true`, `modules: [{ id: "core", required: true }]`, and no `value`

#### Scenario: Store for core
- **WHEN** a PUT targets scope `core` for `GEMINI_API_KEY`
- **THEN** the value is stored encrypted and the listing reports status `set` with scope `core`

#### Scenario: Unknown scope
- **WHEN** a PUT targets scope `nope`
- **THEN** the response is 404
