# Spec Delta

## MODIFIED Requirements

### Requirement: get_current_time

The tool SHALL return the current time as `iso` (UTC ISO 8601), `human` (a spoken-friendly full date and time in the requested zone) and `timezone`. The `timezone` parameter is an optional IANA zone; when omitted, the zone from `FRIDAY_TIMEZONE` SHALL be used, or `Europe/Amsterdam` when that is unset or invalid (an invalid configured zone is logged once as a warning). An explicit `timezone` that is not a valid IANA zone SHALL return an error naming it, rather than silently answering in another zone.

#### Scenario: Default zone
- **WHEN** called without a timezone
- **THEN** `human` is rendered in the default zone and `timezone` names that zone

#### Scenario: Explicit zone
- **WHEN** called with `timezone: "America/New_York"`
- **THEN** `human` is rendered in that zone and `timezone` echoes it

#### Scenario: Invalid configured zone
- **WHEN** `FRIDAY_TIMEZONE` is `Mars/Olympus` and the tool is called without a timezone
- **THEN** `human` is rendered in `Europe/Amsterdam`, `timezone` is `Europe/Amsterdam`, and a warning names `Mars/Olympus`

#### Scenario: Invalid explicit zone
- **WHEN** called with `timezone: "Mars/Olympus"`
- **THEN** the tool returns an error naming `Mars/Olympus`
