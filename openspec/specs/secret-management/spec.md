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

### Requirement: Module reload

`POST /api/modules/:id/reload` SHALL dispose the in-process module if loaded, remove its tools and routes, and initialize it again with current configuration, returning its new module entry. Remote modules and unknown ids SHALL respond 404.

#### Scenario: Fix a failed module
- **WHEN** media failed on a missing required key, the key is saved, and reload is called
- **THEN** media reports `loaded` and its tools are registered

#### Scenario: Reload during a session
- **WHEN** a reload happens while a voice session is open
- **THEN** the session keeps its tool snapshot and the next session sees the reloaded tools

### Requirement: Configuration page

The portal SHALL provide `Settings > Configuration` with pill tabs `Configuration`, `Secrets` and `MCP servers` showing counts. The `Configuration` and `Secrets` tabs SHALL each render one table with a row per key: status dot, key, description, requested-by chips, scope and updated; values SHALL NOT be shown in the table. Clicking a row SHALL open a drawer with the value field (text showing the current value for plain entries, masked for secrets), a scope selector (each requesting module or global), and `Save`, `Save and reload module` and `Clear` actions. Saved secret values SHALL NOT be displayed afterwards. A header action SHALL open the same drawer to add an undeclared global value, stored as secret only from the Secrets tab. The active tab SHALL be reflected in the URL and `?key=` SHALL open the drawer for that key.

#### Scenario: Edit a plain value inline
- **WHEN** the user opens the `JELLYFIN_URL` row, changes the value and saves
- **THEN** the new value is stored plain and shows in the drawer when the row is reopened

#### Scenario: Fill in a pending key
- **WHEN** the user opens a `pending` secret, enters a value and clicks `Save and reload module`
- **THEN** the key shows `set`, the value is not displayed, the module reloads, and the Modules page shows it `loaded`

#### Scenario: Deep link
- **WHEN** the user opens `/settings/config?tab=secrets&key=HA_TOKEN`
- **THEN** the Secrets tab is active and the drawer for `HA_TOKEN` is open

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

### Requirement: MCP servers tab

The `MCP servers` tab SHALL render one table with a row per stored server: status dot (`loaded`, `failed`, `disabled`), name, URL, tool count and updated. A `New server` header action and a click on a row SHALL open a drawer with these fields:
- name (editable only when adding)
- enabled toggle
- `url`
- a list of headers (name and value), with a secret toggle per row
- `include` and `exclude` lists
- a `scheduling` selector
- `prefix`

Secret rows SHALL show a masked placeholder when a value is stored and SHALL never display it. Leaving a stored secret blank SHALL keep it; switching a stored secret to plain SHALL require a new value before saving. When a server has failed, the drawer SHALL show its error. Actions SHALL be `Save`, `Reconnect` (existing enabled servers) and `Delete` (after confirmation). After an action the row SHALL show the resulting status and tool count. When `FRIDAY_MASTER_KEY` is unset, the tab SHALL show the secrets banner and new secret values SHALL NOT be accepted. `?tab=mcp&server=<name>` SHALL open the drawer for that server.

#### Scenario: Add an HTTP server with a token
- **WHEN** the user clicks `New server`, enters name `home`, enters the URL, adds header `Authorization` with the secret toggle on and a bearer token, and saves
- **THEN** the row shows `home` as `loaded` with its tool count, and reopening the drawer shows the header masked with no value

#### Scenario: Change a filter without touching the token
- **WHEN** the user opens `home`, adds `turn_on` to `include`, leaves the masked token blank and saves
- **THEN** the server reconnects with the stored token and the tool count drops to 1

#### Scenario: Failed server
- **WHEN** the user saves a server whose URL is unreachable
- **THEN** the row shows `failed` and the drawer shows the connection error

#### Scenario: No master key
- **WHEN** `FRIDAY_MASTER_KEY` is unset and the user opens the MCP servers tab
- **THEN** the banner is shown, plain headers can still be saved, and saving a new secret value is not possible

#### Scenario: Deep link
- **WHEN** the user opens `/settings/config?tab=mcp&server=home`
- **THEN** the MCP servers tab is active and the drawer for `home` is open
