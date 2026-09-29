# Proposal

## Why

Modules read `FRIDAY_TIMEZONE` through `ctx.config` on every call, so a value saved in the portal applies to them at once. Core's scheduler reads it from the environment once at startup, so cron ignores the portal: after saving `America/New_York`, notes are dated in New York while `brain/nightly` still fires at 03:00 Amsterdam. That was left out of `shared-timezone-helper` on purpose and documented as a gap.

Discovery found a second problem in how the value gets saved. The portal's drawer defaults a key's scope to its first requester, so saving `FRIDAY_TIMEZONE` without touching the selector stores it as "builtin only". `brain` and `travel` never see it, and neither would cron. Reopening a key stored for one module also preselects the first requester instead of where it is actually stored.

## What Changes

- Core declares `FRIDAY_TIMEZONE` (plain, optional) as a requester, next to `GEMINI_API_KEY`, and the scheduler resolves it the way core resolves its own keys: `core` scope, then `global`, then the environment.
- When `FRIDAY_TIMEZONE` is saved or cleared in the portal, the scheduler re-resolves it and, if the zone changed, re-plans every cron job's next run in the new zone without a restart. The Jobs page and `/api/jobs` show the new zone and next runs. Interval (`everyMs`) jobs are untouched.
- The portal's drawer preselects the scope a value is stored in, otherwise the only requester, otherwise `global`. A key several requesters declare (today only `FRIDAY_TIMEZONE`) therefore saves globally by default, reaching cron and every module in one save.
- Docs drop the "cron reads the environment only" caveat.

## Capabilities

### New Capabilities
<!-- None -->

### Modified Capabilities
- `background-jobs`: cron's zone comes from the configuration store (core, global, env), and a saved change re-plans cron jobs live.
- `secret-management`: core also declares `FRIDAY_TIMEZONE`; the configuration drawer's default scope rule changes.

## Impact

- Code: `packages/core/src/core-config.ts` (declare the key), `packages/core/src/jobs/scheduler.ts` (zone reader, re-plan), `packages/core/src/app.ts` (notify on config PUT/DELETE), `packages/core/src/server.ts` (wiring), `packages/core/src/config.ts` (drop `settings.timezone`), `packages/portal/src/pages/settings/ConfigurationPage.vue` plus a new `packages/portal/src/lib/config-scope.ts`.
- Tests: `packages/core/test/jobs.test.ts`, `packages/core/test/platform-api.test.ts`, new `packages/portal/test/config-scope.test.ts`.
- Docs: README (jobs section), `.env.example`, `openspec/config.yaml` context.
- Migration: a `FRIDAY_TIMEZONE` already stored for one module (for example "builtin only") keeps applying to that module only. The deploy notes say to re-save it as global.
- In flight: none.
