# Spec Delta

## MODIFIED Requirements

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

## ADDED Requirements

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
