# Design

## Context

Friday runs as a single Node process, one replica in k8s, with `friday.db` on a PVC. Modules get their platform services through `createContext` (`packages/sdk/src/context.ts`), and `ModuleHost` (`packages/core/src/module-host.ts`) owns their lifecycle: `init`, `teardown` on reload, and `dispose` on shutdown. Tools and routes are already removed per owner during teardown, and jobs slot into the same place. Nothing in core runs on a timer today apart from WebSocket keep-alive. `FRIDAY_TIMEZONE` already exists as the builtin module's default zone. See `proposal.md` for motivation and `specs/` for behaviour.

## Goals / Non-Goals

**Goals:**
- One scheduler, owned by core, that both core and modules use.
- Deterministic tests: scheduling logic testable with an injected clock, and module jobs testable through the test host without timers.
- Restarts and reloads are unremarkable: no lost history, no duplicate runs, and one catch-up run at most.

**Non-Goals:**
- Distributed locking or leader election (single replica).
- Retry with backoff inside a run. A failed run waits for its next due time.
- Sub-second precision. Runs start within about a second of their due time.

## Decisions

### Scheduler lives in core, the contract lives in the SDK
`packages/sdk` gains the job types (`JobSpec`, `JobContext`, `JobResult`, `ModuleJobs`) and a `validateJob()` that both hosts call, so the test host and core reject exactly the same declarations. `packages/core/src/jobs/` holds the `Scheduler` (timers, overlap guard, catch-up, recording) and a `JobStore` over SQLite. `ModuleHost` receives the scheduler through a new `jobs?: (moduleId) => ModuleJobs` option, like `storage`. Core's own jobs register with owner `core` directly on the scheduler.

*Alternative:* a separate jobs package. Rejected, because there's a single consumer and the SDK/core split already fits.

### `croner` for cron parsing and next-run computation, own timers for execution
`croner` has no dependencies, handles IANA zones and DST correctly, and computes `nextRun(from)`. We use it only to compute due times, and to validate expressions inside `validateJob` (so it becomes a dependency of `@friday/sdk`). Execution, the overlap guard, catch-up and recording are ours, because croner's own scheduling knows nothing about persistence, cancellation or run records.

*Alternatives:* `node-cron` (no reliable next-run API for catch-up), or a hand-written parser (DST edge cases aren't worth owning).

### One timer per job, re-armed after each due time
Each job holds one `setTimeout` to its next due time, capped at 2^31-1 ms and re-armed on expiry, because Node timers overflow beyond about 24.8 days. When the timer fires, the scheduler computes the next due time from the *due time*, not from "now", so a slow event loop doesn't drift a cron job. Interval jobs compute `lastDue + everyMs`. The clock (`now()`) and the timer functions are injected, so tests can drive time deterministically.

### Catch-up via a persisted `last_due_at`
The `job_state(job_id, last_due_at)` row is updated whenever a scheduled or catch-up run *starts* (a skipped due time also advances it). On registration: `next = nextDue(last_due_at)`. If `next <= now`, one catch-up run is queued after a short startup delay (`FRIDAY_JOB_CATCHUP_DELAY_MS`, default 30 s, so the server and MCP sources settle first), and `last_due_at` becomes the most recent missed due time. A job with no state row just records `now` and waits. Manual and module runs never touch `last_due_at`, so they can't suppress or cause a catch-up.

Reload goes through the same path. The state row survives the reload, so a reloaded module doesn't get a spurious catch-up.

### Run records and outcomes
Migration 3 adds:
```
job_runs(id TEXT PK, job_id TEXT, trigger TEXT, started_at TEXT, finished_at TEXT,
         outcome TEXT, summary TEXT, error TEXT)   -- index (job_id, started_at DESC)
job_state(job_id TEXT PK, last_due_at TEXT)
```
A row is inserted with outcome `running` when a run starts, and updated when it settles. After a crash, rows still marked `running` from before the process started are rewritten to `cancelled` with error `interrupted by restart` at startup. Pruning to `FRIDAY_JOB_HISTORY` happens in the same transaction as the insert. `skipped` runs are inserted already finished, with zero duration. The summary is capped at 500 characters and the error at 2000.

### Cancellation and lifecycle
Every run gets an `AbortController`. Timeouts abort with a `timeout` reason, and `removeOwner(id)` or `stop()` abort with a `cancelled` reason. The outcome is decided when the handler *settles*: `ok` if it resolves without an abort, `failed` if it throws or resolves after a timeout abort, and `cancelled` after a dispose or shutdown abort. The running flag is held until the handler settles, even after an abort. That is what enforces "the next run doesn't start until the previous one settled". A handler that ignores its signal stays visible as running in the portal instead of being silently overlapped.

`ModuleHost.teardown` calls `scheduler.removeOwner(id)` and waits up to 10 s for in-flight runs to settle before calling `module.dispose()`, then logs a warning for any run still going. On shutdown, `scheduler.stop()` runs before `host.dispose()`, with the same grace period.

### Module-facing API
```ts
ctx.jobs.schedule({ name, description?, cron? , everyMs?, timeoutMs?, run })
  // run: (job: { signal, log, trigger }) => void | JobResult | Promise<void | JobResult>
  // JobResult = { summary?: string }
ctx.jobs.trigger(name): { started: boolean }
```
`schedule` validates synchronously and throws, so a bad declaration fails `init` like any other init error. On the remote runner, `createContext`'s default `jobs` throws `jobs are not available in this host` from `schedule`. The test host collects declarations into `host.jobs` (`{ name, cron?, everyMs? }[]`) and implements `runJob(name)` by calling the handler with a live `AbortSignal` and trigger `manual`, returning `{ outcome, summary?, error? }`.

`core` becomes a reserved module id in `validateManifest`, so job ids (`<owner>/<name>`) can't collide.

### API and portal
Routes are added to `createApp` next to `/api/keys`: `GET /api/jobs`, `GET /api/jobs/:owner/:name/runs`, `POST /api/jobs/:owner/:name/run` (202 `{ runId }`, 409, or 404). The portal gets `pages/settings/JobsPage.vue` at `/settings/jobs` with a `System` nav item (icon `clock`). It is built from `PageLayout`, `DataTable`, `StatusDot`, `Drawer` and `Button`, with times formatted through `formatDateTime`. The schedule is shown as the cron expression plus the zone, or as "every 15 min" for intervals; a cron-to-prose library isn't worth adding. While any job runs, the page polls `/api/jobs` every 3 s.

## Risks / Trade-offs

- [Handler ignores its abort signal and hangs] → The job stays "running" and never runs again until restart. This is visible in the portal with `runningSince`, and the startup cleanup marks the run `cancelled`. We accept this rather than risk overlapping runs.
- [Clock jumps (NTP correction, DST)] → Due times are recomputed from croner in the zone, and intervals aren't tied to wall-clock slots. A backwards jump can delay one interval run; this is acceptable.
- [Catch-up of a heavy nightly job right after a crash loop] → At most one catch-up per registration, after a 30 s delay. A crash-looping pod would retry it on every start. The run record makes the pattern visible.
- [croner becomes an SDK dependency, so remote modules pull it in too] → It is small and has no dependencies. Validating in one place outweighs the few kilobytes.
- [Reserving `core` as a module id is a contract change] → No existing module uses it. It fails loudly at load if one ever does.

## Migration Plan

Migration 3 only creates new tables, so it is safe on existing databases. Rollback means deploying the previous image: the old code ignores the new tables, and `schema_version` stays at 3 harmlessly, since earlier migrations never check for a higher version. New env vars (`FRIDAY_JOB_HISTORY`, `FRIDAY_JOB_CATCHUP_DELAY_MS`) have defaults. `FRIDAY_TIMEZONE` is now also read by core, and its `.env.example` comment is updated to say so.
