# Spec Delta

## Purpose

Lets the user provide the configuration values modules declare, stored encrypted by core and resolved ahead of environment variables, and lets a module be reloaded so new values take effect without restarting Friday.

## ADDED Requirements

### Requirement: Encrypted configuration store

Configuration values SHALL be stored encrypted with AES-256-GCM using the 32-byte base64 `FRIDAY_MASTER_KEY`, a random IV per value, and `scope:key` as additional authenticated data. When `FRIDAY_MASTER_KEY` is unset the store SHALL be disabled, writes SHALL fail with 503 and a message, and reads SHALL fall back to the environment. A value that fails to decrypt SHALL be logged and treated as unset.

#### Scenario: Save and read
- **WHEN** `JELLYFIN_API_KEY` is saved for scope `media`
- **THEN** the database row is ciphertext and `config.get` in media returns the plaintext

#### Scenario: No master key
- **WHEN** `FRIDAY_MASTER_KEY` is unset
- **THEN** `PUT /api/config/...` responds 503 and the portal shows a banner explaining how to set the key

#### Scenario: Wrong master key
- **WHEN** rows were encrypted with a different key
- **THEN** startup logs one error per row and those keys show as `pending`

### Requirement: Resolution order

`ctx.config.get(key)` SHALL resolve module scope, then `global` scope, then the process environment. Values SHALL be read lazily so a reloaded module observes new values.

#### Scenario: Module overrides global
- **WHEN** `HA_URL` is set globally and also for `media`
- **THEN** media reads its own value and other modules read the global one

#### Scenario: Env fallback
- **WHEN** a key is not stored but present in the environment
- **THEN** `config.get` returns the environment value and the API reports status `env`

### Requirement: Configuration API

`GET /api/config` SHALL list every declared key per module plus global entries with `status` (`set`, `pending`, `env`), never including values. `PUT /api/config/:scope/:key` SHALL store a value; `DELETE` SHALL remove it. Scope SHALL be a loaded module id or `global`.

#### Scenario: Listing
- **WHEN** media declares three keys and one is stored
- **THEN** the list shows one `set` and two `pending` (or `env`) entries without values

#### Scenario: Unknown scope
- **WHEN** a PUT targets scope `nope`
- **THEN** the response is 404

### Requirement: Module reload

`POST /api/modules/:id/reload` SHALL dispose the in-process module if loaded, remove its tools and routes, and initialize it again with current configuration, returning its new module entry. Remote modules and unknown ids SHALL respond 404.

#### Scenario: Fix a failed module
- **WHEN** media failed on a missing required key, the key is saved, and reload is called
- **THEN** media reports `loaded` and its tools are registered

#### Scenario: Reload during a session
- **WHEN** a reload happens while a voice session is open
- **THEN** the session keeps its tool snapshot and the next session sees the reloaded tools

### Requirement: Configuration page

The portal SHALL provide `Settings > Configuration` grouping declared keys by module with status badges, a form to set or clear each value, a scope selector (module or global), and a `Save and reload module` action. Saved values SHALL NOT be displayed afterwards.

#### Scenario: Fill in a pending key
- **WHEN** the user enters a value for a `pending` key and clicks `Save and reload module`
- **THEN** the key shows `set`, the module reloads, and the Modules page shows it `loaded`
