## MODIFIED Requirements

### Requirement: Shell layout and navigation

The portal SHALL render a sidebar with a brand row, three sections labelled `Assistant`, `Modules` and `System`, and a user menu. `Assistant` SHALL contain `Talk`, `Chat`, `Conversations` and `Agents`. `Modules` SHALL contain one entry per enabled module UI that is available to the user (`available` in `/api/modules`), ordered by `nav.order` then label, and SHALL be left out when there is none. `System` SHALL contain the pages listed in "Settings section" and SHALL be shown only to admins. Items SHALL show an icon (named icon or text fallback). The active route SHALL be highlighted. `Chat` SHALL be highlighted on `/chat` and on every `/chat/<id>`, and `Agents` on `/agents` and every route under it. The shell SHALL work at widths down to 360 px by collapsing the sidebar into a menu.

#### Scenario: Default navigation
- **WHEN** an admin loads the portal with `builtin` and `media` enabled and only `media` declaring a UI
- **THEN** the sidebar shows `Talk`, `Chat`, `Conversations` and `Agents` under Assistant, `Media` under Modules, and the Settings section's pages, starting with `Modules`, under System

#### Scenario: Member navigation
- **WHEN** a member loads the portal
- **THEN** the sidebar shows Assistant and the module UIs available to them under Modules, and no System section

#### Scenario: Disabled module hidden
- **WHEN** `/api/modules` reports `media` as `disabled` or `failed`
- **THEN** no `Media` nav item is shown and `/m/media` renders a "module not available" page

#### Scenario: Disabled module page
- **WHEN** a user opens `/m/sonos` while `sonos` is disabled
- **THEN** the page says the module is turned off for this Friday and does not mention an environment variable; an admin also gets a link to `/settings/modules`, a member does not

#### Scenario: Module not available to the user
- **WHEN** a user opens `/m/sonos` while `sonos` is not available to them
- **THEN** no `Sonos` nav item is shown, and the page says the module isn't available to them and to ask an admin, without saying who may use it

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

The Modules page SHALL be served at `/settings/modules`, and `/modules` SHALL redirect there. It SHALL list every entry from `/api/modules` as one table row with status dot, label, kind (core, in-process, MCP server, remote), tool count, and actions: `Open` when the module has a UI and is loaded, `Reload` for in-process modules that are not disabled, and an enable/disable switch for in-process modules. The `core` entry SHALL be shown with kind `core`. A row whose module has an access setting other than the default SHALL show who may use it: `Chosen users` for `mode: chosen`, or `Some tools restricted` when tools are restricted. Clicking a row SHALL open a drawer showing description, full tool list, error if failed, connection time for remotes, and the same switch for in-process modules. It SHALL refresh when re-opened and offer a `Refresh` header action.

Turning a switch off SHALL ask for confirmation, saying that the module's tools, pages and jobs stop and that its data and settings are kept. Turning a switch on SHALL need no confirmation. The switch SHALL call `PUT /api/modules/:id/enabled` and update the row, and the sidebar, with the returned entry, showing the error when the module failed to start. A request that fails SHALL leave the switch in its previous position and show the error.

The drawer SHALL have an **Access** section for every entry that has `access` (every kind except `core` and `builtin`), with:
- **Who may use it:** a choice between `Everyone` and `Chosen users`.
- **Chosen users:** a list of the users from `GET /api/users`. The household owner is shown as always included and can't be unticked. Disabled users are shown as disabled.
- **Restricted tools:** a checkbox per tool, meaning only the chosen users get it, and a field for patterns with `*`. This section SHALL be shown only for `Everyone`. Tools matched by a pattern SHALL show as restricted.
- **New tools:** a tool that is not in `knownTools` SHALL be marked new, so an admin notices tools that appeared since the access was last saved.
- **Saving:** `Save` SHALL call `PUT /api/modules/:id/access`, and `Reset to everyone` SHALL call `DELETE /api/modules/:id/access`. Both SHALL update the row with the returned entry. A request that fails SHALL keep the drawer's edits and show the error.

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

#### Scenario: Restrict Home Assistant tools
- **WHEN** the admin opens the `mcp:HomeAssistant` drawer, keeps `Everyone`, ticks Raymond as chosen user, ticks `HomeAssistant__restart_ha`, adds the pattern `HomeAssistant__*delete*` and saves
- **THEN** `PUT /api/modules/mcp:HomeAssistant/access` is sent with those values, and the row shows `Some tools restricted`

#### Scenario: New tool marked
- **WHEN** Home Assistant gained `HomeAssistant__wipe_history` after its access was saved
- **THEN** the drawer marks `HomeAssistant__wipe_history` as new

#### Scenario: No access section for core
- **WHEN** the admin opens the `Core` or `Builtin` drawer
- **THEN** there is no Access section
