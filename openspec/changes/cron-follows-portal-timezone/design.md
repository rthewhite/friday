# Design

## Context

- `packages/core/src/server.ts` builds the `Scheduler` with `timezone: settings.timezone`, the raw `process.env.FRIDAY_TIMEZONE` read at import. The scheduler resolves it once in its constructor (`resolveTimeZone`) and keeps `readonly timezone`.
- Each cron job's `nextDue` is computed by `next(job, from)` → `nextCronRun(cron, this.timezone, from)` when the job registers and again after each run, and `arm(job)` sets one timer per job. Nothing recomputes `nextDue` for another reason.
- Core already resolves its own keys live: `coreConfig(configStore, env)` returns a resolver for `core` scope → `global` → env, used for `GEMINI_API_KEY` at each use. `coreManifest` declares only `GEMINI_API_KEY`.
- `PUT` / `DELETE /api/config/:scope/:key` in `packages/core/src/app.ts` write the `ConfigStore` and return 204. Nothing is notified.
- `ConfigurationPage.vue` `openEntry` preselects `global` when the stored scope is `global` or no module declares the key, otherwise `e.modules[0]`: the first requester, even when the value is stored for another one.

## Goals / Non-Goals

**Goals:**
- One portal save of `FRIDAY_TIMEZONE` (default scope) reaches cron and every module, with cron re-planned at once.

**Non-Goals:**
- Automatically moving a value already stored for one module to `global`. That is a one-time manual step, noted in the migration plan.
- Watching the environment or the database for changes made outside the API. Only the configuration API changes stored values while Friday runs.
- A general config-change event system. One narrow hook, below.

## Decisions

**Core declares `FRIDAY_TIMEZONE`.** Add `{ key: "FRIDAY_TIMEZONE", description: "IANA zone for cron job schedules (default Europe/Amsterdam)" }` to `coreManifest`. The key then lists `core` as a requester, the drawer offers `core` as a scope, and the resolver is the one core already uses. Alternative: read the `global` scope directly in the scheduler. Rejected: it would be the only core key that skips the `core` scope and resolves unlike `GEMINI_API_KEY`.

**The scheduler takes a zone reader and can re-plan.** `SchedulerOptions.timezone` becomes `string | (() => string | undefined)`, so the tests that pass a string keep working. `server.ts` passes `() => coreKey("FRIDAY_TIMEZONE")`. `timezone` becomes a getter over a private field. A new `refreshTimezone()`:

1. resolves the reader through the SDK's `householdTimeZone` (logged as an error, once per distinct invalid value), so cron and modules share one resolution; `resolveTimeZone` returns `Intl`'s canonical spelling, so `europe/amsterdam` is no change;
2. returns if the zone is unchanged;
3. otherwise logs `jobs: timezone changed to <zone>; N cron job(s) re-planned`, and for every cron job clears its timer, stores `now` as its due time, sets `nextDue = next(job, now)` and re-arms it. It leaves `everyMs` jobs, `active` runs and `catchup` timers alone.

Storing `now` as the due time was added after code review: the first draft left the old zone's due time in place, so a restart later that day computed the new zone's slot from it (03:00 New York, already past) and ran an unneeded catch-up.

The constructor calls the same resolution, so startup and live changes behave the same.

**One notification hook on the configuration API.** `AppDeps` gets `onConfigChange?: (scope: string, key: string) => void`, called after a successful `PUT` or `DELETE`. A listener that throws is logged, not turned into a 500, because the write is already committed. `server.ts` wires `followTimezone(jobs)`, exported from `core-config.ts` as `(_, key) => { if (key === "FRIDAY_TIMEZONE") jobs.refreshTimezone(); }`, so the tests use exactly the wiring the server does. The scope does not matter, because `refreshTimezone` re-resolves anyway and a module-scope write resolves to the same zone. Alternatives: poll every minute (a delay and a timer for a rare event), or have `ConfigStore` emit events (widens a storage class for one consumer).

**`settings.timezone` goes away.** `packages/core/src/config.ts` no longer reads `FRIDAY_TIMEZONE`, and the resolver covers the environment. The "settings defaults for jobs" test drops its timezone assertion.

**Portal default scope as a tested pure function.** `packages/portal/src/lib/config-scope.ts` exports `defaultScope(entry: { scope?: string; modules: { id: string }[] }): string`: the stored `scope` when present, else `modules[0].id` when there is exactly one requester, else `"global"`. `openEntry` uses it. It lives in `src/lib` so `node:test` can run it without a Vue test harness, next to `markdown.ts` and `sse.ts` (tested in `test/chat-lib.test.ts`).

## Risks / Trade-offs

- [A zone change can make a daily job run twice, or skip once, on the day of the change: re-planning from now may land on a slot that already ran in the old zone's terms (Amsterdam → New York at 05:00 UTC plans 03:00 New York, 07:00 UTC, after the 01:00 UTC run)] → Accepted: zone changes are rare and deliberate, and the jobs involved (nightly consolidation, retention) are safe to run twice. Documented in the README.
- [A value stored for one module keeps shadowing global for that module] → The resolution order is by design. The migration note tells the user to re-save it as global; the drawer now shows where the value lives.
- [Saving a timezone from outside the API (for example SQL on `friday.db`) is not picked up until restart] → Out of scope; the API is the only supported writer.

## Migration Plan

After deploying, open Settings > Configuration > `FRIDAY_TIMEZONE`. If it shows a module scope (`builtin`, `brain` or `travel`), clear it and save the same value with scope `global`. Rollback is reverting the merge; nothing new is stored.
