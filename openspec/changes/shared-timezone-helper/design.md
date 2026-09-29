# Design

## Context

Current copies of the household-zone logic (see proposal.md for why this matters):

| Where | Reads | Invalid zone | Warns |
|---|---|---|---|
| `modules/builtin/src/index.ts` | `ctx.config.get` per call | not checked: `toLocaleString` throws | never |
| `modules/brain/src/time.ts` (`safeLocalDate`), used by `index.ts` and `nightly/render.ts` | `ctx.config.get` per call | `Europe/Amsterdam` | every call |
| `modules/travel/src/helpers.ts` (`resolveTimeZone`) + `index.ts` | `ctx.config.get` per call | `Europe/Amsterdam` | once per value |
| `packages/core/src/config.ts` → `jobs/scheduler.ts` | `process.env` once at startup | UTC | once, as an error |

`brain` also exports `localDate` and `DEFAULT_TIMEZONE` from its index; only its own test imports them. Modules may depend only on `@friday/sdk`, so a shared helper has to live there.

## Goals / Non-Goals

**Goals:**
- One default, one validity check and one fallback, in `@friday/sdk`, used by all four places.
- `travel`'s warn-once behaviour for every module.

**Non-Goals:**
- Cron schedules following a portal-saved `FRIDAY_TIMEZONE` (separate change; see proposal).
- Moving `travel`'s wall-clock-to-offset conversion (`zoneOffsetMinutes`) or `brain`'s transcript formatting into the SDK. Each has one user; they stay in their module and take an already-resolved zone.
- Changing the `Scheduler` default when no `timezone` option is passed (UTC). Core always passes one; only tests rely on the default.

## Decisions

**A new `packages/sdk/src/time.ts`, exported from the root `@friday/sdk`.** It is small, pure `Intl` and has no node-only imports, so it is safe for `@friday/sdk/remote` users too. A separate `@friday/sdk/time` subpath would add a `package.json` export for no isolation benefit (subpaths exist for `db`, which needs `node:sqlite`, and `test`). Exports:

- `DEFAULT_TIME_ZONE = "Europe/Amsterdam"`
- `resolveTimeZone(zone: string | undefined): { zone: string; valid: boolean }`: the body of `travel`'s version, with blank treated as unset.
- `localDate(at: Date, zone: string): string`: moved from `brain` unchanged.
- `householdTimeZone(config: Pick<ModuleConfig, "get">, warn: (msg: string) => void): () => string`: reads `FRIDAY_TIMEZONE` on every call and remembers the last invalid value it warned about. It takes `ctx.config` and a warn function rather than the whole `ctx`, so core-side code and tests can call it without building a context.

Alternative: add `ctx.timeZone()` to `ModuleContext`. Rejected: it widens the module contract every host (in-process, remote, test) must implement, for something a plain function over `ctx.config` already does.

**Warning text is shared.** `FRIDAY_TIMEZONE "<value>" is not a valid zone; using Europe/Amsterdam`, the wording `brain` and `travel` already use, so existing log searches keep working.

**`brain`:** `index.ts` builds one reader, passes `() => zone()` wherever it passed `ctx.config.get("FRIDAY_TIMEZONE")`, and `render.ts` / `extract.ts` take an already-resolved `string` instead of `string | undefined` plus a warn callback. `src/time.ts` is deleted. `index.ts` stops re-exporting `localDate`/`DEFAULT_TIMEZONE`, and its test imports `localDate` from `@friday/sdk`. Behaviour is unchanged apart from warning once.

**`travel`:** `helpers.ts` drops `DEFAULT_TIME_ZONE`/`resolveTimeZone` and imports `DEFAULT_TIME_ZONE` from the SDK as the default for `validateTimeArgs`. `index.ts` replaces its hand-rolled warn-once with the reader. Its tests of `resolveTimeZone` move to the SDK's tests.

**`builtin`:** `zone = timezone || reader()`. An explicit invalid `timezone` from the model keeps today's behaviour (the `RangeError` "Invalid time zone specified: Mars/Olympus" becomes the tool's `{ error }`), which the spec now states. Silently answering in Amsterdam to "what time is it in Mars/Olympus" would be wrong in a way the model cannot notice.

**Core:** `config.ts` keeps reading `process.env.FRIDAY_TIMEZONE` and uses `DEFAULT_TIME_ZONE` for unset. `Scheduler` validates with `resolveTimeZone` and, when invalid, logs `jobs: invalid timezone "<zone>" (FRIDAY_TIMEZONE); cron jobs are scheduled in Europe/Amsterdam` and uses the default. The existing invalid-zone test changes from UTC to Amsterdam.

## Risks / Trade-offs

- [A deployment with an invalid `FRIDAY_TIMEZONE` sees cron jobs shift from UTC to Amsterdam after upgrading] → Only reachable through misconfiguration, which already logs an error at every startup; the homelab sets no invalid value. Called out as BREAKING in the proposal.
- [Removing `brain`'s `localDate` export breaks an outside importer] → None exists in the workspace (checked with grep); modules may not import each other anyway.
- [The reader remembers only the last invalid value, so alternating between two invalid values warns each time] → Not a real configuration pattern; the log stays bounded by config changes.
