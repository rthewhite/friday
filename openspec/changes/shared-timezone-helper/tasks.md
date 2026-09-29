# Tasks

## 1. SDK helper

- [x] 1.1 Add `packages/sdk/src/time.ts` with `DEFAULT_TIME_ZONE`, `resolveTimeZone`, `localDate` and `householdTimeZone`, and export it from `packages/sdk/src/index.ts`; add `packages/sdk/test/time.test.ts` covering a valid zone, unset and blank (default, no warning), an invalid zone warning once across three calls with the shared wording, a zone changed between calls, a new invalid value warning again, and `localDate` across midnight in `Europe/Amsterdam`; verify `pnpm --filter @friday/sdk test` and `typecheck` pass and `pnpm --filter @friday/sdk build` emits `dist/time.js`

## 2. Modules

- [x] 2.1 `builtin`: resolve the default zone with `householdTimeZone(ctx.config, ctx.log.warn)` and use `DEFAULT_TIME_ZONE` in the manifest description; add tests to `modules/builtin/test/builtin.test.ts` for an invalid configured zone (answers in `Europe/Amsterdam`, one warning naming `Mars/Olympus`) and an invalid explicit zone (an `{ error }` naming it); verify `pnpm --filter @friday/module-builtin test` and `typecheck` pass
- [x] 2.2 `brain`: build one reader in `src/index.ts`, make `nightly/render.ts` and `nightly/extract.ts` take a resolved zone string, delete `src/time.ts` and the `localDate`/`DEFAULT_TIMEZONE` re-export, import `localDate` in `test/tools.test.ts` from `@friday/sdk`, and add a test that an invalid `FRIDAY_TIMEZONE` dates a `brain_remember` note in Amsterdam and warns once across two calls; verify `pnpm --filter @friday/module-brain test` (including the nightly fixtures) and `typecheck` pass
- [x] 2.3 `travel`: remove `DEFAULT_TIME_ZONE`/`resolveTimeZone` from `src/helpers.ts` (import the default from `@friday/sdk`), replace the warn-once code in `src/index.ts` with the reader, and drop the `resolveTimeZone` tests now covered in the SDK; verify the existing "invalid FRIDAY_TIMEZONE falls back and warns once" module test still passes, along with `pnpm --filter @friday/module-travel test` and `typecheck`

## 3. Core scheduler

- [x] 3.1 Use `resolveTimeZone`/`DEFAULT_TIME_ZONE` in `packages/core/src/jobs/scheduler.ts` and `packages/core/src/config.ts`, fall back to `Europe/Amsterdam` for an invalid zone with the error naming it, and change the invalid-zone test in `packages/core/test/jobs.test.ts` to expect `{ cron: "0 3 * * *", timezone: "Europe/Amsterdam" }`; update the scheduler's option comment; verify `pnpm --filter @friday/core test` and `typecheck` pass

## 4. Documentation

- [x] 4.1 Update `FRIDAY_TIMEZONE` wherever it is documented (README, `.env.example`, `openspec/config.yaml` context): one default and fallback, `Europe/Amsterdam`, for modules and cron, and a note that cron reads it from the environment at startup only; verify with `grep -rn FRIDAY_TIMEZONE README.md .env.example openspec/config.yaml` that no text still says cron falls back to UTC

## 5. Integration

- [x] 5.1 Run `pnpm -r build && pnpm -r typecheck && pnpm -r test`; verify all green, and confirm with `grep -rn "Europe/Amsterdam" packages/*/src modules/*/src` that the literal remains only in `packages/sdk/src/time.ts` (plus schema examples in tool descriptions)
