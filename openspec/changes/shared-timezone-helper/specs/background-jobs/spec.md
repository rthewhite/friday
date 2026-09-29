# Spec Delta

## MODIFIED Requirements

### Requirement: Cron schedules follow the configured timezone

Cron expressions SHALL be evaluated in the IANA zone from `FRIDAY_TIMEZONE` (default `Europe/Amsterdam` when unset or blank), including daylight-saving transitions. An invalid zone SHALL be logged as an error at startup, and cron expressions SHALL then be evaluated in `Europe/Amsterdam`, the same default zone modules fall back to.

#### Scenario: Nightly in local time
- **WHEN** `FRIDAY_TIMEZONE` is `Europe/Amsterdam` and a job has `cron: "0 3 * * *"`
- **THEN** it runs at 03:00 Amsterdam time in both winter and summer

#### Scenario: Invalid zone
- **WHEN** `FRIDAY_TIMEZONE` is `Mars/Olympus`
- **THEN** startup logs an error naming the zone and cron jobs are scheduled in `Europe/Amsterdam`
