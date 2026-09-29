# Proposal

## Why

The household zone (`FRIDAY_TIMEZONE`, default `Europe/Amsterdam`) is resolved in four places: `modules/builtin`, `modules/brain` (`src/time.ts`), `modules/travel` (`src/helpers.ts`), and core's job scheduler. Each copy holds its own default and its own idea of an invalid zone, and they have drifted apart:

- `builtin` does not validate at all: an invalid `FRIDAY_TIMEZONE` makes `get_current_time` return an error instead of the time.
- The scheduler falls back to UTC; `brain` and `travel` fall back to `Europe/Amsterdam`. On a bad value the nightly job runs at 03:00 UTC while its notes are dated in Amsterdam.
- `brain` warns on every call with an invalid zone; `travel` warns once.

## What Changes

- `@friday/sdk` exports one time-zone helper: the default zone, a validity check with fallback to the default, a per-module reader of `FRIDAY_TIMEZONE` that warns once per invalid value, and `localDate` (moved from `brain`).
- `builtin`, `brain` and `travel` use it and drop their own copies. `get_current_time` falls back to the default zone (with a warning) when the configured zone is invalid, instead of failing. An invalid zone passed explicitly by the model still fails, naming the zone.
- Core's scheduler validates through the helper. **BREAKING (misconfiguration only):** with an invalid `FRIDAY_TIMEZONE`, cron jobs now run in `Europe/Amsterdam` instead of UTC, matching every module. A valid zone behaves exactly as before.
- `brain` warns once per invalid value instead of on every call.

Not in this change: making cron schedules follow a `FRIDAY_TIMEZONE` saved in the portal (the scheduler reads the environment at startup only). That needs its own proposal, because portal values can be stored per module scope and a change must re-plan running schedules.

## Capabilities

### New Capabilities
<!-- None -->

### Modified Capabilities
- `module-system`: `@friday/sdk` exports the household time-zone helper (added requirement).
- `background-jobs`: an invalid `FRIDAY_TIMEZONE` falls back to `Europe/Amsterdam`, not UTC.
- `builtin-tools`: `get_current_time` falls back to the default zone when the configured zone is invalid, and reports an invalid explicit zone as an error.

## Impact

- New: `packages/sdk/src/time.ts`, `packages/sdk/test/time.test.ts`; exported from `packages/sdk/src/index.ts`.
- Edited: `modules/builtin/src/index.ts`; `modules/brain/src/{index.ts,time.ts,nightly/render.ts,nightly/extract.ts}` (`time.ts` removed or reduced to a re-export); `modules/travel/src/{index.ts,helpers.ts}`; `packages/core/src/{config.ts,jobs/scheduler.ts}`; their tests (`packages/core/test/jobs.test.ts` invalid-zone case, `modules/builtin/test/builtin.test.ts`).
- Docs: README and `.env.example` lines on `FRIDAY_TIMEZONE`, `openspec/config.yaml` context.
- No new dependencies. Remote modules can use the helper too (it is pure `Intl`).
- In flight: none (`git worktree list` shows only main).
