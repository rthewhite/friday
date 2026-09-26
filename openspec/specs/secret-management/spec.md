# Secret Management

## Purpose

Lets the user provide the configuration values modules declare, stored encrypted by core and resolved ahead of environment variables, and lets a module be reloaded so new values take effect without restarting Friday.

## Requirements

### Requirement: Encrypted configuration store

Configuration values SHALL be stored per (scope, key) as either **secret** or **plain**. Secret values SHALL be stored encrypted with AES-256-GCM using the 32-byte base64 `FRIDAY_MASTER_KEY`, a random IV per value, and `scope:key` as additional authenticated data. Plain values SHALL be stored as plaintext and SHALL NOT depend on the master key. A key declared `secret: true` by any module SHALL always be stored secret; undeclared keys use the `secret` flag of the write request, defaulting to plain. When `FRIDAY_MASTER_KEY` is unset, secret writes SHALL fail with 503 and a message, secret reads SHALL fall back to the environment, and plain values SHALL keep working. A secret value that fails to decrypt SHALL be logged and treated as unset. Rows created before the split SHALL be treated as secret.

#### Scenario: Save and read
- **WHEN** `JELLYFIN_API_KEY` (declared secret) is saved for scope `media`
- **THEN** the database row is ciphertext and `config.get` in media returns the plaintext

#### Scenario: Save and read a plain value
- **WHEN** `JELLYFIN_URL` (not declared secret) is saved for scope `media`
- **THEN** the database row holds the plaintext and `config.get` in media returns it

#### Scenario: No master key
- **WHEN** `FRIDAY_MASTER_KEY` is unset
- **THEN** `PUT /api/config/media/JELLYFIN_API_KEY` responds 503, `PUT /api/config/media/JELLYFIN_URL` responds 204, and the portal shows the banner on the Secrets tab only

#### Scenario: Wrong master key
- **WHEN** secret rows were encrypted with a different key
- **THEN** startup logs one error per row, those keys show as `pending`, and plain rows are unaffected

#### Scenario: Declared secret cannot be downgraded
- **WHEN** a PUT for a key some module declares `secret: true` carries `secret: false`
- **THEN** the value is still stored encrypted

### Requirement: Resolution order

`ctx.config.get(key)` SHALL resolve module scope, then `global` scope, then the process environment. Values SHALL be read lazily so a reloaded module observes new values.

#### Scenario: Module overrides global
- **WHEN** `HA_URL` is set globally and also for `media`
- **THEN** media reads its own value and other modules read the global one

#### Scenario: Env fallback
- **WHEN** a key is not stored but present in the environment
- **THEN** `config.get` returns the environment value and the API reports status `env`

### Requirement: Configuration API

`GET /api/config` SHALL return `{ secretsEnabled, entries }` with one entry per key: `key`, `secret`, `required` (true when any requester requires it), `description`, `modules` (array of `{ id, required }` declaring the key; empty for undeclared globals), `status` (`set`, `pending`, `env`), `scope`, `updatedAt` for stored values, and `value` for plain entries with a stored or environment value. Secret entries SHALL never include a value. `PUT /api/config/:scope/:key` with `{ value, secret? }` SHALL store a value; `DELETE` SHALL remove it. Scope SHALL be a loaded module id or `global`.

#### Scenario: Listing
- **WHEN** media declares `JELLYFIN_URL` (plain, stored) and `JELLYFIN_API_KEY` (secret, stored)
- **THEN** the URL entry has `secret: false`, `modules: [{ id: "media", required: true }]`, its `value` and `updatedAt`; the key entry has `secret: true`, status `set`, and no `value`

#### Scenario: Shared key appears once
- **WHEN** two modules declare `HA_URL`
- **THEN** the listing has one `HA_URL` entry whose `modules` lists both

#### Scenario: Env plain value is visible
- **WHEN** `HA_URL` is plain and comes from the environment
- **THEN** its entry has status `env` and includes the environment value

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

The portal SHALL provide `Settings > Configuration` with pill tabs `Configuration` and `Secrets` showing counts, each rendering one table with a row per key: status dot, key, description, requested-by chips, scope and updated; values SHALL NOT be shown in the table. Clicking a row SHALL open a drawer with the value field (text showing the current value for plain entries, masked for secrets), a scope selector (each requesting module or global), and `Save`, `Save and reload module` and `Clear` actions. Saved secret values SHALL NOT be displayed afterwards. A header action SHALL open the same drawer to add an undeclared global value, stored as secret only from the Secrets tab. The active tab SHALL be reflected in the URL and `?key=` SHALL open the drawer for that key.

#### Scenario: Edit a plain value inline
- **WHEN** the user opens the `JELLYFIN_URL` row, changes the value and saves
- **THEN** the new value is stored plain and shows in the drawer when the row is reopened

#### Scenario: Fill in a pending key
- **WHEN** the user opens a `pending` secret, enters a value and clicks `Save and reload module`
- **THEN** the key shows `set`, the value is not displayed, the module reloads, and the Modules page shows it `loaded`

#### Scenario: Deep link
- **WHEN** the user opens `/settings/config?tab=secrets&key=HA_TOKEN`
- **THEN** the Secrets tab is active and the drawer for `HA_TOKEN` is open
