# Spec Delta

## MODIFIED Requirements

### Requirement: Modules page

The `Modules` route SHALL list every entry from `/api/modules` as one table row with status dot, label, kind (core, in-process, MCP server, remote), tool count, and an action (`Open` when the module has a UI, `Reload` for in-process modules). The `core` entry SHALL be shown with kind `core`. Clicking a row SHALL open a drawer showing description, full tool list, error if failed, and connection time for remotes. It SHALL refresh when re-opened and offer a `Refresh` header action.

#### Scenario: Listing
- **WHEN** the page opens
- **THEN** each module is a row with its status dot, kind and tool count

#### Scenario: Details
- **WHEN** the user clicks the `media` row
- **THEN** a drawer lists its tools and description

#### Scenario: Core's tools
- **WHEN** the page opens and `/api/modules` has a `core` entry with the timer tools
- **THEN** a `Core` row with kind `core` and its tool count is listed, and its drawer lists `set_timer`, `list_timers`, `cancel_timer` and `snooze_alert`

### Requirement: Reload action on the Modules page

Each in-process module row SHALL offer a `Reload` action calling `POST /api/modules/:id/reload` and refreshing the row; remote and MCP rows, and the `core` row, SHALL show no reload action.

#### Scenario: Reload from the list
- **WHEN** the user clicks `Reload` on a failed module whose config is now set
- **THEN** the row updates to `loaded` with its tool count

#### Scenario: Core can't be reloaded
- **WHEN** the page lists the `core` row
- **THEN** neither the row nor its drawer offers `Reload`
