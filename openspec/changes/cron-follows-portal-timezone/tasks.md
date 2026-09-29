# Tasks

## 1. Scheduler follows a zone reader

- [x] 1.1 In `packages/core/src/jobs/scheduler.ts`, accept `timezone` as a string or a reader, expose `timezone` as a getter, and add `refreshTimezone()` that re-resolves, logs an invalid value once per distinct value, and, when the zone changed, re-plans every cron job's `nextDue` from now and re-arms it, leaving interval jobs, active runs, catch-up timers and stored due times alone; add tests to `packages/core/test/jobs.test.ts` with a mutable reader and the fake clock: a change re-plans `0 3 * * *` to 03:00 New York and `list()` reports the new zone and next run; an unchanged zone re-plans nothing; an `everyMs` job keeps its next run; an invalid value falls back to Amsterdam and logs one error across two refreshes; a job's run in progress is not cancelled; verify `pnpm --filter @friday/core test` and `typecheck` pass

## 2. Core resolves FRIDAY_TIMEZONE from the configuration store

- [x] 2.1 Declare `FRIDAY_TIMEZONE` (plain, optional) in `coreManifest`, drop `timezone` from `packages/core/src/config.ts` (and its assertion in the "settings defaults for jobs" test), add `onConfigChange` to `AppDeps` called after a successful `PUT` and `DELETE` of `/api/config/:scope/:key`, and wire `server.ts` to build the scheduler with `() => coreKey("FRIDAY_TIMEZONE")` and call `jobs.refreshTimezone()` when `FRIDAY_TIMEZONE` changes; add tests to `packages/core/test/platform-api.test.ts`: the listing shows `FRIDAY_TIMEZONE` as plain, not required, with `core` among its requesters; a `PUT` and a `DELETE` call `onConfigChange` with scope and key, a rejected `PUT` does not; and, with a scheduler built from a store-backed reader, a global `PUT` of `America/New_York` makes `/api/jobs` report that zone and the re-planned next run; verify `pnpm --filter @friday/core test` and `typecheck` pass

## 3. Portal default scope

- [x] 3.1 Add `packages/portal/src/lib/config-scope.ts` with `defaultScope(entry)` (stored scope, else the only requester, else `global`) and use it in `ConfigurationPage.vue` `openEntry`; add `packages/portal/test/config-scope.test.ts` covering a shared unstored key (`global`), a single requester (that module), a value stored for one module (that module), a value stored globally (`global`) and an undeclared global (`global`); verify `pnpm --filter @friday/portal test`, `typecheck` and `build` pass

## 4. Documentation

- [x] 4.1 Update the README jobs "Time zone" bullet, `.env.example` and the `openspec/config.yaml` context: cron resolves `FRIDAY_TIMEZONE` like core's keys (core, global, env) and re-plans when it is saved; the portal saves a shared key globally by default; a zone change can make a daily job run twice or skip once that day; and a value stored for one module applies to that module only (re-save it as global). Verify with `grep -rn "environment only\|once at startup" README.md .env.example openspec/config.yaml` that no text still says cron ignores the portal

## 5. Integration

- [ ] 5.1 Run `pnpm -r build && pnpm -r typecheck && pnpm -r test`; verify all green
- [ ] 5.2 Start the built core on a free port with a scratch data dir and `FRIDAY_TIMEZONE` unset; check that `GET /api/jobs` reports `Europe/Amsterdam` for `brain/nightly`, then `PUT /api/config/global/FRIDAY_TIMEZONE` with `America/New_York`, check that `/api/jobs` now reports `America/New_York` and a next run at 03:00 New York time, then `DELETE` it and check that it is back to `Europe/Amsterdam`; stop the server afterwards
