# Tasks

## 1. Module scaffold and wiring

- [x] 1.1 Create `modules/travel` (`package.json` as `@friday/module-travel` with build/typecheck/test scripts like `modules/media`, `tsconfig.json`, `src/index.ts` exporting `createTravelModule(opts)` and a default module with id `travel`, label `Travel`, and `TOMTOM_API_KEY` declared required and secret); verify `pnpm install` succeeds and `pnpm --filter @friday/module-travel build` produces `dist/index.js`
- [x] 1.2 Register the module: add it to `packages/core/src/modules.ts` and as a `workspace:*` dependency of `packages/core`, and copy its `package.json` in the `Dockerfile` install layer; verify `pnpm --filter @friday/core typecheck` and `pnpm --filter @friday/core test` pass

## 2. Helpers and errors

- [x] 2.1 Port `errors.ts` and `types.ts` from Jarvis unchanged; verify `pnpm --filter @friday/module-travel typecheck` passes
- [x] 2.2 Port `helpers.ts` (`parseCoordinates`, `formatDuration`, `validateTimeArgs`) and `test/helpers.test.ts` from the Jarvis vitest cases to `node:test`; verify all ported cases pass
- [x] 2.3 Change `validateTimeArgs` to take a time zone and render offset-less times with that zone's offset (past check on the resulting instant, invalid zone falls back to `Europe/Amsterdam`); add tests for `Europe/Amsterdam` in summer (+02:00) and winter (+01:00), an explicit `Z`/offset passed through, and a local time that is past in the zone but not in UTC; verify `pnpm --filter @friday/module-travel test` passes

## 3. TomTom client

- [x] 3.1 Port `tomtom.ts` with an injected logger instead of `createLogger`, and a 10 s `AbortSignal.timeout` on every request; port `test/tomtom.test.ts` (endpoints and API versions, URL encoding, POI vs address names, not-found, credential/entitlement errors, upstream and transport errors, no key in messages, route params, summary mapping, `NO_ROUTE_FOUND`, cache hits/normalisation/negative caching/TTL/eviction/no route caching); add a test that an aborted request becomes an upstream error without status and that no log line contains the key; verify `pnpm --filter @friday/module-travel test` passes

## 4. Tool

- [ ] 4.1 Port `travel-time.ts` (`getTravelTime`, taking the time zone) and `test/travel-time.test.ts`; verify the ported cases pass
- [ ] 4.2 Define `get_travel_time` in `src/index.ts` with a `Type` schema matching the Jarvis parameter descriptions, the client built from `ctx.config.require("TOMTOM_API_KEY")`, the zone from `ctx.config.get("FRIDAY_TIMEZONE")`, and `ctx.log` as the logger; add `test/module.test.ts` with `createTestHost` covering: missing key fails the module naming `TOMTOM_API_KEY`, the tool is offered on voice and chat, an end-to-end call against a fake `fetch` returns the spec's result shape, a bare local `departAt` reaches TomTom with the `FRIDAY_TIMEZONE` offset, and a 403 yields an `{ error }` result without the key; verify `pnpm --filter @friday/module-travel test` and `typecheck` pass

## 5. Documentation

- [ ] 5.1 Add a "Travel time (TomTom)" section to `README.md` (the tool, what it answers, getting a TomTom key with Routing and Places Search entitlements, setting `TOMTOM_API_KEY`), a `TOMTOM_API_KEY` block in `.env.example`, `TOMTOM_API_KEY` in the `deploy/k8s.yaml` secrets comment, and the travel module in the `openspec/config.yaml` context; verify by reading the diff that each file mentions the module and key consistently

## 6. Integration

- [ ] 6.1 Run `pnpm -r build && pnpm -r typecheck && pnpm -r test`; verify all green
- [ ] 6.2 With a real `TOMTOM_API_KEY` from `.env` (if available), start core on a free port and call `get_travel_time` through `POST /api/chat` or the Modules page to confirm a live answer; stop the dev server afterwards. Record in the task if skipped for lack of a key
