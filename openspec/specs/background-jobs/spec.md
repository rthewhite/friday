# Background Jobs

## Purpose

Lets core and in-process modules run work on a schedule, without a conversation: jobs that never overlap themselves, that catch up once after downtime, and whose every run is recorded and visible in the portal.

## Requirements

### Requirement: Jobs are declared with a name and a schedule

A job SHALL have an owner (a module id, or `core` for core's own jobs), a kebab-case `name` unique per owner, an optional `description`, a handler, and exactly one schedule: a five-field cron expression (`cron`) or a fixed interval in milliseconds (`everyMs`, at least 1000). A job's id SHALL be `<owner>/<name>`. A declaration with an invalid name, a duplicate name, an invalid cron expression, both or neither schedule kinds, or an interval below the minimum SHALL be rejected with an error naming the job. The module id `core` SHALL be reserved, and a module declaring it SHALL fail to load.

#### Scenario: Cron job
- **WHEN** module `brain` declares `{ name: "nightly", cron: "0 3 * * *", run }`
- **THEN** job `brain/nightly` is registered with its next run at the coming 03:00

#### Scenario: Interval job
- **WHEN** a module declares `{ name: "poll", everyMs: 900000, run }`
- **THEN** the job's next run is 15 minutes after it was declared

#### Scenario: Invalid cron
- **WHEN** a module declares a job with `cron: "61 * * * *"`
- **THEN** the declaration throws an error naming the job and the expression

#### Scenario: Duplicate name
- **WHEN** a module declares two jobs named `nightly`
- **THEN** the second declaration throws

### Requirement: Cron schedules follow the configured timezone

Cron expressions SHALL be evaluated in the IANA zone from `FRIDAY_TIMEZONE`, resolved like core's own configuration: the value stored for `core`, then the `global` value, then the process environment, and `Europe/Amsterdam` when none is set or the value is blank. Daylight-saving transitions SHALL be handled. An invalid zone SHALL be logged as an error naming it, and cron expressions SHALL then be evaluated in `Europe/Amsterdam`, the same default zone modules fall back to. When `FRIDAY_TIMEZONE` is saved or cleared through the configuration API, core SHALL resolve the zone again and, when it changed, SHALL re-plan the next run of every cron job from the current time in the new zone, without a restart. Interval jobs, runs in progress and pending catch-up runs SHALL NOT be affected. A restart after a zone change SHALL NOT catch up a slot of the new zone that fell before the change. Zones that differ only in letter case SHALL count as the same zone. The jobs listing SHALL report the current zone.

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

#### Scenario: Restart after a zone change
- **WHEN** `brain/nightly` ran at 03:00 Amsterdam, the zone was changed to `America/New_York` at 14:00 Amsterdam, and Friday restarts an hour later
- **THEN** no catch-up run starts, and the next run is 03:00 New York the next day

#### Scenario: Unrelated key saved
- **WHEN** a key other than `FRIDAY_TIMEZONE` is saved, or `FRIDAY_TIMEZONE` is saved with the zone already in effect
- **THEN** no cron job is re-planned

### Requirement: A job never overlaps itself

At most one run of a job SHALL be in progress at a time. When a scheduled run comes due while the previous run is still going, the new run SHALL NOT start and SHALL be recorded with outcome `skipped`. The next due run SHALL be scheduled as usual. Different jobs SHALL run independently of each other.

#### Scenario: Slow run
- **WHEN** an `everyMs: 60000` job's run takes 150 seconds
- **THEN** the runs due during it are recorded as `skipped` and no second run starts while the first is in progress

#### Scenario: Other jobs are unaffected
- **WHEN** job `a/slow` is running and job `b/quick` comes due
- **THEN** `b/quick` runs

### Requirement: Missed runs are caught up once

Core SHALL persist, per job, the due time of the last scheduled run. When a job is registered and its next due time after that persisted time has already passed, for example because Friday was down, the job SHALL run once shortly after registration, with trigger `catch-up`, however many due times were missed. It SHALL then continue on its schedule. A job registered for the first time SHALL NOT be caught up.

#### Scenario: Down over the nightly slot
- **WHEN** Friday is down from 02:00 to 04:00 and a job has `cron: "0 3 * * *"`
- **THEN** after startup the job runs once with trigger `catch-up`, and next at 03:00 the following night

#### Scenario: Down for several days
- **WHEN** Friday was down for three days
- **THEN** the nightly job is caught up with one run, not three

#### Scenario: New job
- **WHEN** a job is registered that has never run before
- **THEN** it waits for its first due time

### Requirement: Every run is recorded

Each run SHALL be recorded with its job id, trigger (`schedule`, `catch-up`, `manual` or `module`), start time, duration, outcome (`ok`, `failed`, `skipped` or `cancelled`), an optional short summary returned by the handler, and the error message when it failed. Core SHALL keep the most recent `FRIDAY_JOB_HISTORY` runs per job (default 50) and delete older ones. Each run's start and end SHALL be logged with the job id.

#### Scenario: Successful run with a summary
- **WHEN** a handler resolves with `{ summary: "deleted 12 conversations" }`
- **THEN** the run is recorded as `ok` with that summary and its duration

#### Scenario: Bounded history
- **WHEN** a job has 50 recorded runs and runs again
- **THEN** its oldest run is deleted

### Requirement: A failing run does not affect the schedule or the server

A handler that throws or rejects SHALL have its run recorded as `failed` with the error message, and the job SHALL run again at its next due time. No job failure SHALL crash the process or affect other jobs.

#### Scenario: Handler throws
- **WHEN** a handler throws `Error("jellyfin unreachable")`
- **THEN** the run is `failed` with that message, the server keeps running, and the job runs again at its next due time

### Requirement: Runs can be cancelled

A handler SHALL receive an abort signal, a logger prefixed with the owner, and the run's trigger. A job MAY declare `timeoutMs`. When a run exceeds it, the signal SHALL be aborted and the run recorded as `failed` with a timeout message once the handler settles. When a job's owner is disposed or Friday shuts down, the signal of any in-progress run SHALL be aborted, and the run recorded as `cancelled`. The job's next run SHALL NOT start until the previous run's handler has settled.

#### Scenario: Timeout
- **WHEN** a job declares `timeoutMs: 60000` and its run takes longer
- **THEN** the run's signal is aborted and the run is recorded as `failed` with a timeout message

#### Scenario: Shutdown during a run
- **WHEN** Friday receives SIGTERM while a job is running
- **THEN** the run's signal is aborted and the run is recorded as `cancelled`

### Requirement: Jobs can be run on demand

A job SHALL be startable outside its schedule, by its owner (trigger `module`) or through the API (trigger `manual`). A run started this way SHALL follow the no-overlap rule, and SHALL NOT change when the next scheduled run is due. When the job is already running, the request SHALL NOT start a run, and the caller SHALL be told so.

#### Scenario: Run now
- **WHEN** a user starts `brain/nightly` at 14:00 through the API
- **THEN** a run with trigger `manual` starts, and the next scheduled run is still 03:00

#### Scenario: Already running
- **WHEN** a run is requested for a job that is running
- **THEN** no run starts and the caller is told the job is already running

### Requirement: Jobs API

`GET /api/jobs` SHALL list registered jobs with `id`, `owner`, `name`, `description`, `schedule` (`cron` with `timezone`, or `everyMs`), `nextRunAt`, `running` (with `runningSince`), and `lastRun`. `GET /api/jobs/:owner/:name/runs` SHALL return that job's recorded runs, newest first. `POST /api/jobs/:owner/:name/run` SHALL start a manual run and respond 202, or respond 409 when the job is running. Unknown jobs SHALL respond 404. Jobs of modules that are disabled or failed SHALL NOT be listed.

#### Scenario: Listing
- **WHEN** `brain/nightly` is registered and last ran successfully
- **THEN** `/api/jobs` includes it with its cron schedule, timezone, next run, and a `lastRun` with outcome `ok`

#### Scenario: Conflict
- **WHEN** `POST /api/jobs/brain/nightly/run` arrives while that job is running
- **THEN** the response is 409

### Requirement: Jobs page

The portal SHALL provide a `Jobs` page at `/settings/jobs` with one table row per job: status dot (last outcome, or running), name, owner, schedule in readable form, next run, and last run with its duration. Clicking a row SHALL open a drawer with the description, the schedule, and the run history (time, trigger, outcome, duration, summary or error), plus a `Run now` action that is disabled while the job runs. The page SHALL offer a `Refresh` header action, and SHALL refresh itself while any job is running.

#### Scenario: Inspect a failure
- **WHEN** the user opens a job whose last run failed
- **THEN** the drawer's history shows that run as `failed` with its error message

#### Scenario: Run now from the portal
- **WHEN** the user clicks `Run now`
- **THEN** the row shows the job running, and the run appears in the history with trigger `manual` when it finishes
