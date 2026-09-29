# Spec Delta

## MODIFIED Requirements

### Requirement: Cron schedules follow the configured timezone

Cron expressions SHALL be evaluated in the IANA zone from `FRIDAY_TIMEZONE`, resolved like core's own configuration: the value stored for `core`, then the `global` value, then the process environment, and `Europe/Amsterdam` when none is set or the value is blank. Daylight-saving transitions SHALL be handled. An invalid zone SHALL be logged as an error naming it, and cron expressions SHALL then be evaluated in `Europe/Amsterdam`, the same default zone modules fall back to. When `FRIDAY_TIMEZONE` is saved or cleared through the configuration API, core SHALL resolve the zone again and, when it changed, SHALL re-plan the next run of every cron job from the current time in the new zone, without a restart. Interval jobs, runs in progress and pending catch-up runs SHALL NOT be affected. The jobs listing SHALL report the current zone.

#### Scenario: Nightly in local time
- **WHEN** `FRIDAY_TIMEZONE` is `Europe/Amsterdam` and a job has `cron: "0 3 * * *"`
- **THEN** it runs at 03:00 Amsterdam time in both winter and summer

#### Scenario: Invalid zone
- **WHEN** `FRIDAY_TIMEZONE` is `Mars/Olympus`
- **THEN** an error naming the zone is logged and cron jobs are scheduled in `Europe/Amsterdam`

#### Scenario: Stored value wins over the environment
- **WHEN** the environment has `FRIDAY_TIMEZONE=Europe/Amsterdam` and `America/New_York` is stored globally
- **THEN** cron jobs are scheduled in `America/New_York`

#### Scenario: Zone saved while running
- **WHEN** Friday runs with jobs in `Europe/Amsterdam` and the user saves `FRIDAY_TIMEZONE=America/New_York` globally
- **THEN** without a restart, `brain/nightly` (`0 3 * * *`) is next due at 03:00 New York time, and `/api/jobs` reports `America/New_York` with that next run

#### Scenario: Zone cleared while running
- **WHEN** a stored `FRIDAY_TIMEZONE` is deleted and the environment has none
- **THEN** cron jobs are re-planned in `Europe/Amsterdam`

#### Scenario: Unrelated key saved
- **WHEN** a key other than `FRIDAY_TIMEZONE` is saved, or `FRIDAY_TIMEZONE` is saved with the zone already in effect
- **THEN** no cron job is re-planned
