# Spec Delta

## ADDED Requirements

### Requirement: Settings section

The sidebar SHALL include a `Settings` group with `Configuration` and `Remote modules` pages, placed after module entries.

#### Scenario: Navigation
- **WHEN** the portal loads
- **THEN** `Settings` shows both pages and they route to `/settings/config` and `/settings/keys`

### Requirement: Reload action on the Modules page

Each in-process module entry SHALL offer a `Reload` button calling `POST /api/modules/:id/reload` and refreshing the entry; remote modules SHALL show no button.

#### Scenario: Reload from the list
- **WHEN** the user clicks `Reload` on a failed module whose config is now set
- **THEN** the entry updates to `loaded` with its tools
