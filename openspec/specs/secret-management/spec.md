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

`GET /api/config` SHALL return `{ secretsEnabled, entries }` with one entry per key: `key`, `secret`, `required` (true when any requester that is not a disabled module requires it), `description`, `modules` (array of `{ id, required }` of the requesters declaring the key, which are `core` and the modules in core's list, with `disabled: true` on a module that is disabled; empty for undeclared globals), `status` (`set`, `pending`, `env`), `scope`, `updatedAt` for stored values, and `value` for plain entries with a stored or environment value. A key declared only by disabled modules SHALL be listed only when it is stored in some scope. The entry's `scope` SHALL come from its requesters (their own scope, then global), those that are not disabled first, so a copy stored in an unrelated module's scope never becomes the entry's scope. Whether a key is secret SHALL take every requester into account, disabled ones included, also when the value comes from the environment. When the key is stored in at least one scope, the entry SHALL also include `stored`: one item per stored scope with `scope`, `updatedAt`, and `value` for plain values, ordered `global`, then `core`, then other scopes by name; `stored` SHALL include scopes that no loaded module declares. Secret entries SHALL never include a value, in `value` or in `stored`. `PUT /api/config/:scope/:key` with `{ value, secret? }` SHALL store a value; `DELETE` SHALL remove it. Scope SHALL be a module in core's list (enabled or not), `core`, or `global` for `PUT`; `DELETE` SHALL accept any scope that holds the key, so a value left behind by a removed module can be cleared.

`PUT /api/config/:scope/:key` with `{ from }` instead of `value` SHALL copy the value the key has stored in scope `from` (any scope that holds the key) into `:scope`, without the value passing through the request or the response. The copy SHALL be stored secret when the source is secret or any requester declares the key secret, and plain otherwise. A body with both `value` and `from`, or neither, SHALL be refused with 400. A `from` scope that holds no value for the key SHALL be refused with 404. A source that is a secret which cannot be read (no master key, or it fails to decrypt) SHALL be refused with 503 and a message, and nothing SHALL be stored. A copy SHALL count as a write to `:scope` for everything that reacts to configuration changes.

#### Scenario: Listing
- **WHEN** media declares `JELLYFIN_URL` (plain, stored) and `JELLYFIN_API_KEY` (secret, stored)
- **THEN** the URL entry has `secret: false`, `modules: [{ id: "media", required: true }]`, its `value` and `updatedAt`; the key entry has `secret: true`, status `set`, and no `value`

#### Scenario: Shared key appears once
- **WHEN** two modules declare `HA_URL`
- **THEN** the listing has one `HA_URL` entry whose `modules` lists both

#### Scenario: Key of a disabled module
- **WHEN** only `travel` declares `TOMTOM_API_KEY`, `travel` is disabled, and the key is stored nowhere
- **THEN** the listing has no `TOMTOM_API_KEY` entry, and enabling `travel` brings it back

#### Scenario: Stored key of a disabled module
- **WHEN** `travel` is disabled, `TOMTOM_API_KEY` is stored for `travel`, and a stray copy is stored for `brain`
- **THEN** the key is listed with `modules: [{ id: "travel", required: true, disabled: true }]`, `required: false`, `secret: true`, scope `travel`, no `value`, and `stored` naming `brain` and `travel`

#### Scenario: Shared key with a disabled module
- **WHEN** `media` and `sonos` declare `HA_URL` and `sonos` is disabled
- **THEN** the `HA_URL` entry's `modules` lists `media`, and `sonos` with `disabled: true`, and only `media` can make it required

#### Scenario: Secret declared by a disabled module
- **WHEN** an active module declares `API_TOKEN` plain, a disabled module declares it secret, and its value comes from the environment
- **THEN** the entry has `secret: true`, status `env`, and no `value`

#### Scenario: Env plain value is visible
- **WHEN** `HA_URL` is plain and comes from the environment
- **THEN** its entry has status `env` and includes the environment value, and has no `stored`

#### Scenario: Core's key is listed
- **WHEN** the configuration is listed
- **THEN** `GEMINI_API_KEY` appears with `secret: true`, `modules: [{ id: "core", required: true }]`, and no `value`

#### Scenario: Store for core
- **WHEN** a PUT targets scope `core` for `GEMINI_API_KEY`
- **THEN** the value is stored encrypted and the listing reports status `set` with scope `core`

#### Scenario: Unknown scope
- **WHEN** a PUT targets scope `nope`
- **THEN** the response is 404

#### Scenario: Every stored scope is listed
- **WHEN** `FRIDAY_TIMEZONE` is stored globally as `Europe/Amsterdam` and for `builtin` as `Asia/Tokyo`
- **THEN** its entry has `stored` with `global` (value `Europe/Amsterdam`) first and `builtin` (value `Asia/Tokyo`) second, each with `updatedAt`

#### Scenario: Secret values stay hidden in stored
- **WHEN** `HA_TOKEN` (secret) is stored for `media` and globally
- **THEN** its `stored` items have `scope` and `updatedAt` but no `value`

#### Scenario: Copy a secret to another module
- **WHEN** `HA_TOKEN` (declared secret) is stored for `media` and a PUT targets scope `sonos` with `{ from: "media" }`
- **THEN** the response is 204 and contains no value, `sonos` reads the same token as `media`, `stored` lists `media` and `sonos`, and the `sonos` copy is stored encrypted

#### Scenario: Copy a plain value
- **WHEN** `HA_URL` (plain) is stored for `media` and a PUT targets scope `sonos` with `{ from: "media" }`
- **THEN** `sonos` reads the same URL, stored plain

#### Scenario: Copy from a scope without the key
- **WHEN** a PUT targets scope `sonos` for `HA_TOKEN` with `{ from: "brain" }` and `brain` stores no `HA_TOKEN`
- **THEN** the response is 404 and nothing is stored

#### Scenario: Value and from together
- **WHEN** a PUT body has both `value` and `from`
- **THEN** the response is 400 and nothing is stored

#### Scenario: Unreadable secret source
- **WHEN** `HA_TOKEN` is stored for `media` but fails to decrypt, and a PUT targets `sonos` with `{ from: "media" }`
- **THEN** the response is 503 with a message and `sonos` stores nothing

### Requirement: Module reload

`POST /api/modules/:id/reload` SHALL dispose the in-process module if loaded, remove its tools and routes, and initialize it again with current configuration, returning its new module entry. A disabled module SHALL respond 409 with an error saying it is disabled, and SHALL stay disabled. Remote modules and unknown ids SHALL respond 404.

#### Scenario: Fix a failed module
- **WHEN** media failed on a missing required key, the key is saved, and reload is called
- **THEN** media reports `loaded` and its tools are registered

#### Scenario: Reload during a session
- **WHEN** a reload happens while a voice session is open
- **THEN** the session keeps its tool snapshot and the next session sees the reloaded tools

#### Scenario: Reload a disabled module
- **WHEN** reload is called for `sonos` while it is disabled
- **THEN** the response is 409, `sonos` is not initialized, and it still reports `disabled`

### Requirement: Configuration page

The portal SHALL provide `Settings > Configuration` with pill tabs `Configuration`, `Secrets` and `MCP servers` showing counts. The `Configuration` and `Secrets` tabs SHALL each render one table with a row per key: status dot, key, description, requested-by chips, scope and updated; values SHALL NOT be shown in the table. The scope cell SHALL show the entry's scope (the first stored scope when no scope wins, for example for secrets that cannot be read) and, when the key is stored in more scopes, how many more (`global +1`). Clicking a row SHALL open a drawer with the value field (text showing the current value for plain entries, masked for secrets), a scope selector, and `Save`, `Save and reload` and `Clear` actions. The drawer SHALL list every scope the key is stored in, with its value for plain entries, its update time and a `Clear` action for that scope; clearing one copy SHALL keep the drawer open on the refreshed entry. It SHALL mark a copy stored for a requester of the key (a module or `core`) as overriding the global value for that requester when a global copy exists, and a copy in a scope that does not request the key as probably left over. When `global` is selected and a requester holds its own copy, whether or not a global copy exists yet, the drawer SHALL say that those requesters keep their own value until it is cleared. Saved secret values SHALL NOT be displayed afterwards. A header action SHALL open the same drawer to add an undeclared global value, stored as secret only from the Secrets tab. The active tab SHALL be reflected in the URL and `?key=` SHALL open the drawer for that key.

The scope selector SHALL let the user select several scopes: one option per requester of the key, and `global (all modules)`. Selecting `global` SHALL deselect the requesters, and selecting a requester SHALL deselect `global`. At least one scope SHALL be selected to save. The selector SHALL preselect the requesters that hold a stored copy, for a plain value only those whose copy equals the value shown, so saving never overwrites a different (override) value unless the user ticks it; when none does, `global` if a global copy exists; when nothing is stored, the only requester when exactly one declares the key, and `global` otherwise, so a key several requesters share is saved for all of them by default.

`Save` SHALL store the value in every selected scope. When the value field is empty and the key is stored, `Save` SHALL copy the stored value into each selected scope that holds no copy yet, and SHALL leave selected scopes that hold a copy unchanged. The source SHALL be the first selected scope that holds a copy, else the scope shown for the entry, else the first stored scope, and the drawer SHALL name it before saving. Saving with an empty value SHALL NOT be possible when the key is stored nowhere or every selected scope already holds a copy. `Save and reload` SHALL be offered when at least one module gets a write, and SHALL reload every module that got one after saving; `global`, `core` and selected modules whose copy was left unchanged are not reloaded. A module that fails to reload SHALL be reported without stopping the other reloads. Deselecting a scope SHALL NOT remove its copy. Scopes SHALL be saved one after another, stopping at the first that fails; the drawer SHALL then stay open, say which scopes were saved, which failed and which were not tried, and show the refreshed stored copies.

#### Scenario: Edit a plain value inline
- **WHEN** the user opens the `JELLYFIN_URL` row, changes the value and saves
- **THEN** the new value is stored plain and shows in the drawer when the row is reopened

#### Scenario: Fill in a pending key
- **WHEN** the user opens a `pending` secret, enters a value and clicks `Save and reload`
- **THEN** the key shows `set`, the value is not displayed, the module reloads, and the Modules page shows it `loaded`

#### Scenario: Deep link
- **WHEN** the user opens `/settings/config?tab=secrets&key=HA_TOKEN`
- **THEN** the Secrets tab is active and the drawer for `HA_TOKEN` is open

#### Scenario: Shared key defaults to global
- **WHEN** the user opens `FRIDAY_TIMEZONE`, which `core`, `builtin`, `brain` and `travel` declare and nothing stores
- **THEN** the scope selector preselects `global` only

#### Scenario: Single requester
- **WHEN** the user opens `JELLYFIN_URL`, which only `media` declares and nothing stores
- **THEN** the scope selector preselects `media`

#### Scenario: Reopen a module-scoped value
- **WHEN** `FRIDAY_TIMEZONE` is stored for `brain` only and the user opens the row
- **THEN** the scope selector preselects `brain`

#### Scenario: Reopen a value stored for two modules
- **WHEN** `HA_TOKEN` is stored for `media` and `sonos` and the user opens the row
- **THEN** the scope selector preselects `media` and `sonos`, and not `global`

#### Scenario: Save for two modules
- **WHEN** the user opens `HA_TOKEN`, which `media` and `sonos` declare and nothing stores, selects `media` and `sonos`, enters a token and clicks `Save and reload`
- **THEN** the token is stored for `media` and for `sonos`, both modules are reloaded, and nothing is stored globally

#### Scenario: Share a stored secret without retyping it
- **WHEN** `HA_TOKEN` is stored for `media` only, and the user opens the row, also selects `sonos`, leaves the value empty and clicks `Save and reload`
- **THEN** the drawer said it copies the value stored for `media`, `sonos` gets a copy, the `media` copy is unchanged, only `sonos` reloads, and it is `loaded`

#### Scenario: Rotate a shared token
- **WHEN** `HA_TOKEN` is stored for `media` and `sonos`, and the user enters a new token with both selected and saves
- **THEN** both copies hold the new token

#### Scenario: A differing override is not preselected
- **WHEN** `FRIDAY_TIMEZONE` is stored for `core` as `Europe/Amsterdam` and for `travel` as `America/New_York`, and the user opens the row, whose value shows `Europe/Amsterdam`
- **THEN** only `core` is preselected, and saving changes only the `core` copy

#### Scenario: Global and modules exclude each other
- **WHEN** `media` and `sonos` are selected and the user selects `global`
- **THEN** only `global` is selected, and selecting `media` again deselects `global`

#### Scenario: Deselecting keeps the copy
- **WHEN** `HA_URL` is stored for `media` and `sonos`, and the user deselects `media`, changes the value and saves
- **THEN** only the `sonos` copy changes, and the `media` copy is still listed with its own `Clear`

#### Scenario: Override is visible and clearable
- **WHEN** `FRIDAY_TIMEZONE` is stored globally and for `builtin`, and the user opens the row
- **THEN** the table showed `global +1`, the drawer lists `global` and `builtin` with their values, marks `builtin` as overriding global for `builtin`, and clearing `builtin` removes only that scope

#### Scenario: Core copy overrides global too
- **WHEN** `FRIDAY_TIMEZONE` is stored globally and for `core`
- **THEN** the drawer marks `core` as overriding global for `core`

#### Scenario: Leftover copy
- **WHEN** `HA_URL` is stored globally and for `gone`, which does not request it
- **THEN** the drawer marks `gone` as probably left over, not as an override, and offers `Clear` for it

#### Scenario: Saving globally over an override
- **WHEN** `FRIDAY_TIMEZONE` is stored for `builtin` and the user selects `global`
- **THEN** the drawer says `builtin` keeps its own value until it is cleared

### Requirement: Disabled modules on the Configuration page

The Configuration page SHALL mark a requester that is a disabled module as off, in the table's requested-by chips and in the drawer. With nothing stored for a key, the drawer's default scope SHALL count only the requesters that are not disabled, unless every requester is disabled, so a disabled module neither sends a key to `global` nor loses its own key to it. `Save and reload` SHALL NOT reload a disabled module that got a write; it reads the value when it is turned on.

#### Scenario: Shared key with a disabled requester
- **WHEN** the admin opens `HA_URL`, declared by `media` and by the disabled `sonos`, with nothing stored
- **THEN** `sonos` is shown as off, and `media` is the preselected scope

#### Scenario: Key only a disabled module declares
- **WHEN** the admin opens `TOMTOM_API_KEY`, stored for the disabled `travel`
- **THEN** `travel` is shown as off and the drawer opens on scope `travel`, not `global`

#### Scenario: Save for a disabled module
- **WHEN** the admin saves a value for the disabled `travel` with `Save and reload` offered for the other selected modules
- **THEN** the value is stored for `travel` and `travel` is not reloaded

### Requirement: Core declares its own configuration

Core SHALL declare its own configuration keys as the requester `core`, in the same shape as a module's `config` entries. It SHALL declare `GEMINI_API_KEY` as secret and required, `FRIDAY_TIMEZONE` as plain and optional (the zone for cron schedules), and `FRIDAY_PUBLIC_URL` as plain and optional (the base URL OAuth redirect URIs are built from, as specified in `oauth-connections`). Core SHALL resolve its keys from the `core` scope, then the `global` scope, then the process environment, and SHALL read them at each use, so a stored value applies to the next voice session, the next text-generation call, the next authorization and, for `FRIDAY_TIMEZONE`, the cron schedules without a restart. A missing required core key SHALL NOT stop core from starting: startup SHALL log a warning naming the key, and features that need it SHALL fail as they do today without a key. `FRIDAY_MASTER_KEY` SHALL be read from the environment only.

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

#### Scenario: Core-only time zone in the drawer
- **WHEN** the user opens `FRIDAY_TIMEZONE` and selects scope `core`
- **THEN** the drawer states that the value re-plans cron jobs at once and is not seen by modules unless saved as global

#### Scenario: Core lists the time zone among its keys
- **WHEN** the configuration listing is requested
- **THEN** the `FRIDAY_TIMEZONE` entry is plain, not required, and lists `core` among its requesters together with the modules that declare it

#### Scenario: Public URL saved in the portal
- **WHEN** the user saves `FRIDAY_PUBLIC_URL` as `https://friday.thewhite.nl` for scope `core`
- **THEN** the next connections listing and the next authorization use redirect URIs under `https://friday.thewhite.nl`, without a restart

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
