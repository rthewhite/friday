# Spec Delta

## MODIFIED Requirements

### Requirement: Shell layout and navigation

The portal SHALL render a sidebar with a brand row and the sections `Assistant`, `Modules` and `System`. `Assistant` SHALL contain `Talk`, `Chat`, `Conversations` and `Agents`. `Modules` SHALL contain one entry per enabled module UI, ordered by `nav.order` then label, and SHALL be left out when there is none. `System` SHALL contain the pages listed in the Settings section requirement. Items SHALL show an icon (named icon or text fallback). The active route SHALL be highlighted, `Chat` SHALL be highlighted on `/chat` and on every `/chat/<id>`, and `Agents` SHALL be highlighted on `/agents` and every route under it. The shell SHALL work at widths down to 360 px by collapsing the sidebar into a menu.

#### Scenario: Default navigation
- **WHEN** the portal loads with `builtin` and `media` enabled and only `media` declaring a UI
- **THEN** the sidebar shows `Talk`, `Chat`, `Conversations` and `Agents` under Assistant, `Media` under Modules, and `Modules`, `Configuration`, `Connections`, `Voice devices`, `Alerts`, `Remote modules` and `Jobs` under System

#### Scenario: Disabled module hidden
- **WHEN** `/api/modules` reports `media` as `disabled` or `failed`
- **THEN** no `Media` nav item is shown and `/m/media` renders a "module not available" page

#### Scenario: Disabled module page
- **WHEN** the user opens `/m/sonos` while `sonos` is disabled
- **THEN** the page says the module is turned off for this Friday and links to `/settings/modules`, and does not mention an environment variable

#### Scenario: No module UIs enabled
- **WHEN** every module that declares a UI is disabled or failed
- **THEN** the sidebar has no `Modules` section

#### Scenario: Chat thread highlighted
- **WHEN** the user is on `/chat/<id>`
- **THEN** the `Chat` item is highlighted

#### Scenario: Agent page highlighted
- **WHEN** the user is on an agent's page under `/agents`
- **THEN** the `Agents` item is highlighted

### Requirement: Modules page

The Modules page SHALL be served at `/settings/modules`, and `/modules` SHALL redirect there. It SHALL list every entry from `/api/modules` as one table row with status dot, label, kind (core, in-process, MCP server, remote), tool count, and actions: `Open` when the module has a UI and is loaded, `Reload` for in-process modules that are not disabled, and an enable/disable switch for in-process modules. The `core` entry SHALL be shown with kind `core`. Clicking a row SHALL open a drawer showing description, full tool list, error if failed, connection time for remotes, and the same switch for in-process modules. It SHALL refresh when re-opened and offer a `Refresh` header action.

Turning a switch off SHALL ask for confirmation, saying that the module's tools, pages and jobs stop and that its data and settings are kept. Turning a switch on SHALL need no confirmation. The switch SHALL call `PUT /api/modules/:id/enabled` and update the row, and the sidebar, with the returned entry, showing the error when the module failed to start. A request that fails SHALL leave the switch in its previous position and show the error.

#### Scenario: Listing
- **WHEN** the page opens
- **THEN** each module is a row with its status dot, kind and tool count, and in-process rows have a switch that is on unless the module is disabled

#### Scenario: Details
- **WHEN** the user clicks the `media` row
- **THEN** a drawer lists its tools and description

#### Scenario: Core's tools
- **WHEN** the page opens and `/api/modules` has a `core` entry with the timer tools
- **THEN** a `Core` row with kind `core` and its tool count is listed, and its drawer lists `set_timer`, `list_timers`, `cancel_timer` and `snooze_alert`

#### Scenario: Old address
- **WHEN** the user opens `/modules`
- **THEN** the portal shows `/settings/modules`

#### Scenario: Disable a module
- **WHEN** the user turns off the switch on the `sonos` row and confirms
- **THEN** the row shows `disabled` with no tools and no `Reload`, and the sidebar no longer shows a `Sonos` entry if it had one

#### Scenario: Cancel a disable
- **WHEN** the user turns off a switch and cancels the confirmation
- **THEN** no request is sent and the switch stays on

#### Scenario: Enable fails
- **WHEN** the user turns on the switch of `media` without its configuration
- **THEN** the switch is on and the row shows `failed` with the error

#### Scenario: No switch for other kinds
- **WHEN** the page lists `core`, an MCP server and a remote module
- **THEN** none of their rows or drawers offers a switch

### Requirement: Settings section

The sidebar's `System` section SHALL contain `Modules`, `Configuration`, `Connections`, `Voice devices`, `Alerts`, `Remote modules` and `Jobs`, routing to `/settings/modules`, `/settings/config`, `/settings/connections`, `/settings/devices`, `/settings/alerts`, `/settings/keys` and `/settings/jobs`.

#### Scenario: Navigation
- **WHEN** the portal loads
- **THEN** `System` shows all seven pages and they route to `/settings/modules`, `/settings/config`, `/settings/connections`, `/settings/devices`, `/settings/alerts`, `/settings/keys` and `/settings/jobs`

### Requirement: Reload action on the Modules page

Each in-process module row that is not disabled SHALL offer a `Reload` action calling `POST /api/modules/:id/reload` and refreshing the row. Disabled rows, remote and MCP rows, and the `core` row SHALL show no reload action.

#### Scenario: Reload from the list
- **WHEN** the user clicks `Reload` on a failed module whose config is now set
- **THEN** the row updates to `loaded` with its tool count

#### Scenario: Core can't be reloaded
- **WHEN** the page lists the `core` row
- **THEN** neither the row nor its drawer offers `Reload`

#### Scenario: Disabled module can't be reloaded
- **WHEN** the page lists a disabled `sonos` row
- **THEN** neither the row nor its drawer offers `Reload`
