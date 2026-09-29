# Spec Delta

## MODIFIED Requirements

### Requirement: Configuration page

The portal SHALL provide `Settings > Configuration` with pill tabs `Configuration`, `Secrets` and `MCP servers` showing counts. The `Configuration` and `Secrets` tabs SHALL each render one table with a row per key: status dot, key, description, requested-by chips, scope and updated; values SHALL NOT be shown in the table. Clicking a row SHALL open a drawer with the value field (text showing the current value for plain entries, masked for secrets), a scope selector (each requesting module or global), and `Save`, `Save and reload module` and `Clear` actions. The scope selector SHALL preselect the scope the value is stored in; for a key with no stored value, the only requester when exactly one declares it, and `global` otherwise, so a key several requesters share is saved for all of them by default. Saved secret values SHALL NOT be displayed afterwards. A header action SHALL open the same drawer to add an undeclared global value, stored as secret only from the Secrets tab. The active tab SHALL be reflected in the URL and `?key=` SHALL open the drawer for that key.

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

### Requirement: Core declares its own configuration

Core SHALL declare its own configuration keys as the requester `core`, in the same shape as a module's `config` entries. It SHALL declare `GEMINI_API_KEY` as secret and required, and `FRIDAY_TIMEZONE` as plain and optional (the zone for cron schedules). Core SHALL resolve its keys from the `core` scope, then the `global` scope, then the process environment, and SHALL read them at each use, so a stored value applies to the next voice session, the next text-generation call and, for `FRIDAY_TIMEZONE`, the cron schedules without a restart. A missing required core key SHALL NOT stop core from starting: startup SHALL log a warning naming the key, and features that need it SHALL fail as they do today without a key. `FRIDAY_MASTER_KEY` SHALL be read from the environment only.

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

#### Scenario: Core lists the time zone among its keys
- **WHEN** the configuration listing is requested
- **THEN** the `FRIDAY_TIMEZONE` entry is plain, not required, and lists `core` among its requesters together with the modules that declare it
