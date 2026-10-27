# Spec Delta

## MODIFIED Requirements

### Requirement: Settings section

The sidebar's `System` section SHALL contain `Configuration`, `Connections`, `Voice devices`, `Alerts`, `Remote modules` and `Jobs`, routing to `/settings/config`, `/settings/connections`, `/settings/devices`, `/settings/alerts`, `/settings/keys` and `/settings/jobs`.

#### Scenario: Navigation
- **WHEN** the portal loads
- **THEN** `System` shows all six pages and they route to `/settings/config`, `/settings/connections`, `/settings/devices`, `/settings/alerts`, `/settings/keys` and `/settings/jobs`
