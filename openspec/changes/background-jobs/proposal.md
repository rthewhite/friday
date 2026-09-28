# Proposal

## Why

Friday can only act when someone talks to it. Upcoming work needs it to act on its own: deleting conversations past their retention, and later a nightly brain pass that turns transcripts into memory. Without a platform scheduler every module would roll its own timers, each re-solving overlap, missed runs, and visibility. This is the first of three foundation changes (then `conversation-store`, then `module-llm`), built first so conversation retention can be its first real job.

## What Changes

- Core gains a job scheduler. A job has an owner (a module id, or `core`), a name, a schedule, and a handler.
- Schedules are cron expressions evaluated in a configured timezone (for "nightly at 03:00"), or fixed intervals.
- A job never overlaps itself: a run that comes due while the previous one is still going is skipped and recorded as `skipped`.
- A run missed while Friday was down is run once at startup, not once per missed slot.
- Every run is recorded (start, duration, outcome `ok` | `failed` | `skipped` | `cancelled`, error message). History is bounded per job.
- A running handler receives an abort signal and a logger. Module dispose and reload stop the module's jobs and abort its in-flight runs.
- Modules get `ctx.jobs.schedule(...)` and can trigger their own jobs on demand. Remote modules do not get `ctx.jobs`, the same rule as `ctx.storage`.
- `createTestHost` exposes the declared jobs and lets tests run one directly.
- HTTP API: list jobs with next and last run, read a job's run history, and "run now".
- Portal: a `Jobs` page under the `System` section showing each job, its schedule, next run, last outcome, and run history, with a `Run now` action.

Out of scope: event-triggered jobs (arrive with `conversation-store`, which introduces the first events), multi-replica coordination (Friday runs as one replica), and job retries beyond the next scheduled run.

## Capabilities

### New Capabilities
- `background-jobs`: scheduling, the no-overlap guard, missed-run catch-up, run history, the jobs API and the `Jobs` page.

### Modified Capabilities
- `module-system`: `ModuleContext` gains `jobs` for in-process modules. Dispose and reload stop a module's jobs. The test host exposes jobs.
- `portal-shell`: the `System` section gains `Jobs` alongside `Configuration` and `Remote modules`.

## Impact

- `packages/sdk`: `ModuleContext.jobs` types, the test host.
- `packages/core`: a new scheduler (e.g. `src/jobs/`), a migration adding a job-runs table to `friday.db`, `/api/jobs` routes, ModuleHost dispose/reload wiring.
- `packages/portal`: a `Jobs` page and nav entry.
- Probably a small cron-parsing dependency. New env vars for the timezone and history size, documented in `.env.example`.
