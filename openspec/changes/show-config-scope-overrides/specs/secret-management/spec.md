# Spec Delta

## MODIFIED Requirements

### Requirement: Configuration API

`GET /api/config` SHALL return `{ secretsEnabled, entries }` with one entry per key: `key`, `secret`, `required` (true when any requester requires it), `description`, `modules` (array of `{ id, required }` of the requesters declaring the key, which are modules and `core`; empty for undeclared globals), `status` (`set`, `pending`, `env`), `scope`, `updatedAt` for stored values, and `value` for plain entries with a stored or environment value. When the key is stored in at least one scope, the entry SHALL also include `stored`: one item per stored scope with `scope`, `updatedAt`, and `value` for plain values, ordered `global`, then `core`, then other scopes by name; `stored` SHALL include scopes that no loaded module declares. Secret entries SHALL never include a value, in `value` or in `stored`. `PUT /api/config/:scope/:key` with `{ value, secret? }` SHALL store a value; `DELETE` SHALL remove it. Scope SHALL be a loaded module id, `core`, or `global` for `PUT`; `DELETE` SHALL accept any scope that holds the key, so a value left behind by a removed module can be cleared.

#### Scenario: Listing
- **WHEN** media declares `JELLYFIN_URL` (plain, stored) and `JELLYFIN_API_KEY` (secret, stored)
- **THEN** the URL entry has `secret: false`, `modules: [{ id: "media", required: true }]`, its `value` and `updatedAt`; the key entry has `secret: true`, status `set`, and no `value`

#### Scenario: Shared key appears once
- **WHEN** two modules declare `HA_URL`
- **THEN** the listing has one `HA_URL` entry whose `modules` lists both

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

### Requirement: Configuration page

The portal SHALL provide `Settings > Configuration` with pill tabs `Configuration`, `Secrets` and `MCP servers` showing counts. The `Configuration` and `Secrets` tabs SHALL each render one table with a row per key: status dot, key, description, requested-by chips, scope and updated; values SHALL NOT be shown in the table. The scope cell SHALL show the entry's scope and, when the key is stored in more scopes, how many more (`global +1`). Clicking a row SHALL open a drawer with the value field (text showing the current value for plain entries, masked for secrets), a scope selector (each requesting module or global), and `Save`, `Save and reload module` and `Clear` actions. The drawer SHALL list every scope the key is stored in, with its value for plain entries, its update time and a `Clear` action for that scope, and SHALL mark a module scope that overrides a global value for that module. When the selected scope is `global` and a module scope also holds the key, the drawer SHALL say that those modules keep their own value until it is cleared. The scope selector SHALL preselect the scope the value is stored in; for a key with no stored value, the only requester when exactly one declares it, and `global` otherwise, so a key several requesters share is saved for all of them by default. Saved secret values SHALL NOT be displayed afterwards. A header action SHALL open the same drawer to add an undeclared global value, stored as secret only from the Secrets tab. The active tab SHALL be reflected in the URL and `?key=` SHALL open the drawer for that key.

#### Scenario: Edit a plain value inline
- **WHEN** the user opens the `JELLYFIN_URL` row, changes the value and saves
- **THEN** the new value is stored plain and shows in the drawer when the row is reopened

#### Scenario: Fill in a pending key
- **WHEN** the user opens a `pending` secret, enters a value and clicks `Save and reload module`
- **THEN** the key shows `set`, the value is not displayed, the module reloads, and the Modules page shows it `loaded`

#### Scenario: Deep link
- **WHEN** the user opens `/settings/config?tab=secrets&key=HA_TOKEN`
- **THEN** the Secrets tab is active and the drawer for `HA_TOKEN` is open

#### Scenario: Shared key defaults to global
- **WHEN** the user opens `FRIDAY_TIMEZONE`, which `core`, `builtin`, `brain` and `travel` declare and nothing stores
- **THEN** the scope selector preselects `global`

#### Scenario: Single requester
- **WHEN** the user opens `JELLYFIN_URL`, which only `media` declares and nothing stores
- **THEN** the scope selector preselects `media`

#### Scenario: Reopen a module-scoped value
- **WHEN** `FRIDAY_TIMEZONE` is stored for `brain` only and the user opens the row
- **THEN** the scope selector preselects `brain`

#### Scenario: Override is visible and clearable
- **WHEN** `FRIDAY_TIMEZONE` is stored globally and for `builtin`, and the user opens the row
- **THEN** the table showed `global +1`, the drawer lists `global` and `builtin` with their values, marks `builtin` as overriding global for `builtin`, and clearing `builtin` removes only that scope

#### Scenario: Saving globally over an override
- **WHEN** `FRIDAY_TIMEZONE` is stored for `builtin` and the user selects scope `global`
- **THEN** the drawer says `builtin` keeps its own value until it is cleared
