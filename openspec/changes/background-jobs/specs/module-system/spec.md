# Spec Delta

## ADDED Requirements

### Requirement: Jobs in the context

`ModuleContext` SHALL include `jobs` for in-process modules. `ctx.jobs.schedule(job)` SHALL declare a job as specified in `background-jobs`, owned by the module id, and SHALL throw on an invalid declaration, so the module fails to load. `ctx.jobs.trigger(name)` SHALL start one of the module's own jobs on demand, and SHALL report whether a run started. When a module is disposed, reloaded, or fails during `init`, its jobs SHALL be removed and any in-progress run cancelled. A reloaded module's jobs SHALL keep their run history and catch-up state across the reload. Hosts without a scheduler, such as the remote runner, SHALL make `ctx.jobs.schedule` throw an error stating that jobs are not available in that host.

#### Scenario: Jobs follow the module lifecycle
- **WHEN** module `brain` with a scheduled job is reloaded
- **THEN** the old job's timers stop and any running run is cancelled, then the job is registered again and its history is intact

#### Scenario: Invalid job fails the module
- **WHEN** a module's `init` schedules a job with an invalid cron expression
- **THEN** the module reports `failed` with the job error, and none of its tools or jobs are registered

#### Scenario: Remote host
- **WHEN** a module run through `runRemote` calls `ctx.jobs.schedule`
- **THEN** it throws an error stating that jobs are not available in this host

### Requirement: Test host runs jobs directly

The test host SHALL record jobs a module schedules, without running any timers. It SHALL expose their names and schedules, and SHALL offer `runJob(name)`, which runs the handler once and resolves to the run's outcome, summary and error. Declarations SHALL be validated as the real host validates them.

#### Scenario: Run a job in a test
- **WHEN** a test calls `host.runJob("nightly")` on a module that schedules `nightly`
- **THEN** the handler runs once and the call resolves to `{ outcome: "ok" }`, with the handler's summary if it returned one

#### Scenario: Invalid schedule in tests
- **WHEN** a module schedules a job with an invalid cron expression under `createTestHost`
- **THEN** `createTestHost` rejects with the same error the real host would report
