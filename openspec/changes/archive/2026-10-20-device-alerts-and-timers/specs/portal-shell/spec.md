# Spec Delta

## MODIFIED Requirements

### Requirement: Settings section

The sidebar's `System` section SHALL contain `Configuration`, `Voice devices`, `Alerts`, `Remote modules` and `Jobs`, routing to `/settings/config`, `/settings/devices`, `/settings/alerts`, `/settings/keys` and `/settings/jobs`.

#### Scenario: Navigation
- **WHEN** the portal loads
- **THEN** `System` shows all five pages and they route to `/settings/config`, `/settings/devices`, `/settings/alerts`, `/settings/keys` and `/settings/jobs`
