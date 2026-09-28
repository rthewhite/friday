# Tasks

## 1. SDK job contract

- [x] 1.1 Add `croner` to `@friday/sdk` dependencies and verify `pnpm install` and `pnpm -r typecheck` succeed
- [x] 1.2 Add job types (`JobSpec`, `JobContext`, `JobResult`, `ModuleJobs`) and `validateJob()` (kebab-case name, exactly one of `cron`/`everyMs`, `everyMs >= 1000`, cron parsed by croner, error names the job), and export them from `@friday/sdk`. Verify with unit tests in `packages/sdk/test/jobs.test.ts` covering each rejection and a valid cron and interval
- [x] 1.3 Reserve module id `core` in `validateManifest`, and verify a test that a manifest with id `core` is rejected
- [x] 1.4 Add `jobs` to `ModuleContext` and `createContext` (default: `schedule` throws `jobs are not available in this host`, `trigger` returns `{ started: false }`). Verify a remote-runner test that `ctx.jobs.schedule` throws with that message
- [x] 1.5 Extend `createTestHost` with `jobs` (declared names and schedules) and `runJob(name)` resolving to `{ outcome, summary?, error? }`, validating through `validateJob`. Verify with test-host tests for a successful run, a throwing handler (`failed` with message), and an invalid cron rejecting `createTestHost`
- [x] 1.6 Document `ctx.jobs` and `runJob` in `packages/sdk/README.md` (ModuleContext and Testing sections), and verify the example compiles by using it verbatim in `jobs.test.ts`

## 2. Core scheduler

- [ ] 2.1 Add migration 3 (`job_runs` with index on `(job_id, started_at DESC)`, `job_state`) to `packages/core/src/storage/db.ts`, and verify `storage.test.ts` applies it on a fresh and on a version-2 database
- [ ] 2.2 Implement `JobStore` in `packages/core/src/jobs/store.ts` (insert running run, finish run, insert skipped run, prune to history size in the same transaction, get/set `last_due_at`, mark stale `running` rows as `cancelled`), and verify with store tests including pruning at 50
- [ ] 2.3 Implement `Scheduler` in `packages/core/src/jobs/scheduler.ts` with an injected clock and timers: register/unregister per owner, next due time via croner in the configured zone (UTC fallback plus an error log for an invalid zone), a timer capped at 2^31-1 ms, overlap guard recording `skipped`, and on-demand runs (`manual`/`module`) that don't touch `last_due_at`. Verify with `packages/core/test/jobs.test.ts` using a fake clock: cron and interval due times, DST for `0 3 * * *` in Europe/Amsterdam, skipped-while-running, and independent jobs
- [ ] 2.4 Implement catch-up on registration (one run after `FRIDAY_JOB_CATCHUP_DELAY_MS` when a due time was missed, none for a first registration, `last_due_at` advanced to the latest missed due time). Verify with fake-clock tests for down-over-one-slot, down-three-days (one run), and a new job
- [ ] 2.5 Implement cancellation: per-run `AbortController`, `timeoutMs` → `failed` with a timeout message, `removeOwner`/`stop()` → `cancelled` with a settle grace, running flag held until the handler settles, failures never escaping the scheduler, and per-run start/end log lines. Verify with tests for timeout, shutdown during a run, a throwing handler (next run still scheduled), and a handler that ignores its signal (no overlap)
- [ ] 2.6 Add `jobHistory`, `jobCatchupDelayMs` and `timezone` to core `settings`, and document `FRIDAY_JOB_HISTORY`, `FRIDAY_JOB_CATCHUP_DELAY_MS`, and core's use of `FRIDAY_TIMEZONE` in `.env.example`. Verify the settings defaults with a unit test

## 3. Wiring into the host and server

- [ ] 3.1 Pass `jobs: (id) => scheduler.forOwner(id)` from `ModuleHost` into `createContext`. Remove the owner's jobs in `teardown` and on init failure, waiting for in-flight runs up to the grace period before `module.dispose()`. Verify `reload.test.ts` and `module-host.test.ts` cases: reload keeps history and causes no spurious catch-up, a failed init leaves no jobs, and dispose cancels a running job
- [ ] 3.2 Create the scheduler in `server.ts` after opening the database, mark stale runs at startup, and stop it before `host.dispose()` on SIGINT/SIGTERM. Verify by starting core locally with a test module job (`everyMs: 5000`), seeing runs logged, and confirming SIGTERM records the in-flight run as `cancelled`

## 4. Jobs API

- [ ] 4.1 Add `GET /api/jobs`, `GET /api/jobs/:owner/:name/runs` and `POST /api/jobs/:owner/:name/run` (202/409/404) to `createApp`, listing only registered jobs. Verify with `platform-api.test.ts` cases for listing shape, runs newest-first, run-now 202, conflict 409, and unknown 404
- [ ] 4.2 Document jobs (declaring, the API, catch-up and overlap behaviour) in a new README section after "Configuration, storage and keys", and verify the section's example `curl` commands against a local core

## 5. Portal Jobs page

- [ ] 5.1 Add a `clock` icon to `@friday/portal-ui` `Icon.vue`, and verify it renders in the portal-ui component test
- [ ] 5.2 Add the `/settings/jobs` route and the `Jobs` item in the `System` nav group, and verify the sidebar shows Configuration, Remote modules and Jobs linking to their routes
- [ ] 5.3 Build `pages/settings/JobsPage.vue`: a table (status dot for last outcome or running, name, owner, readable schedule, next run, last run with duration, `formatDateTime` times), a row drawer with description, schedule, run history and `Run now` (disabled while running), a `Refresh` header action, and 3 s polling while any job runs. Verify `pnpm --filter @friday/portal build` passes and the page works against a local core with a test job: run now, watch it finish, and see a failure's error in the history

## 6. Integration

- [ ] 6.1 Run `pnpm test` and `pnpm -r typecheck` across the workspace and verify both pass
- [ ] 6.2 Deploy to the homelab and verify with a temporary verification job (removed afterwards): the Jobs page loads, a `cron` job runs at its due time in Amsterdam time, and restarting the pod across a due time produces exactly one `catch-up` run
