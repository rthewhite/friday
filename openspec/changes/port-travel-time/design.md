# Design

## Context

The Jarvis tool (`~/Projects/jarvis/tools/travel-time`) is a standalone service built on `@jarvis/framework`: its own Dockerfile and Deployment, a zod schema, pino logging, and `TOMTOM_API_KEY` fetched from `jarvis-config` at startup. Its logic is split cleanly into `helpers.ts` (coordinates, time validation, duration text), `tomtom.ts` (HTTP client with geocode cache and error classification), `travel-time.ts` (orchestration) and `errors.ts`, with 667 lines of vitest tests against a fake `fetch`.

In Friday a module gets everything through `ctx`: `defineTool` with `Type` schemas, `ctx.config` (module scope, then global, then env; `secret: true` keys are encrypted and write-only), and `ctx.log`. The registry already turns a thrown error into `{ error: String(err) }`, so Jarvis's error classes surface to the model unchanged. The Friday container runs in UTC; the household's zone is `FRIDAY_TIMEZONE` (default `Europe/Amsterdam`), which `builtin`'s `get_current_time` already reads through `ctx.config`.

## Goals / Non-Goals

**Goals:**
- Behavioural parity with the Jarvis tool, keeping its file split and tests so the two can be compared side by side.
- Fit Friday's module conventions (`media` is the model: a `createXModule(opts)` factory with an injectable `fetch`, a default export, `node:test` via `createTestHost`).

**Non-Goals:**
- A portal UI, stored "home"/"work" places, or cycling, walking and transit modes. The brain's prompt context already tells the model where home is, so it can pass an address.
- Running it as a remote module.

## Decisions

**Module id `travel`, tool `get_travel_time`.** Friday tool names are snake_case verbs (`get_current_time`, `get_next_episode`); Jarvis's `get-travel-time` capability name does not fit. `travel` leaves room for related tools later without renaming the module. Alternative: id `travel-time`; rejected as narrower with no benefit.

**Port the files nearly verbatim.** `helpers.ts`, `errors.ts`, `types.ts`, `tomtom.ts` and `travel-time.ts` move over with only the framework seams changed: `createLogger` becomes a logger passed in (`ctx.log`), and `fetch` stays injectable through the client options. `index.ts` becomes the `defineModule`. This keeps the debugged TomTom specifics (Routing apiVersion 2 vs Places apiVersion 1, no `sectionType`, sniffing `NO_ROUTE_FOUND` in 4xx bodies, `poi.name` vs `freeformAddress`) intact. Alternative: rewrite in the denser `media` style; rejected because it risks losing those details for no functional gain.

**Create the client lazily, once per init.** `ctx.config.require("TOMTOM_API_KEY")` is read when the client is first needed, so a key changed in the portal takes effect on module reload, which also resets the geocode cache. The key stays in a query parameter as TomTom requires; it is kept out of logs by never logging URLs (Jarvis's rule) and out of errors because error messages are built from status and body detail only.

**Bare local times in `FRIDAY_TIMEZONE`.** Jarvis normalised offset-less times through the process zone, which in Friday's UTC container would shift "08:00" by one or two hours. `validateTimeArgs` gets the zone as a parameter; for an offset-less value it parses the wall-clock fields, computes that zone's UTC offset at that instant with `Intl.DateTimeFormat` (`timeZoneName: "longOffset"`), and emits the same wall-clock time with that offset (`2026-10-01T08:00:00+02:00`). The past-`departAt` check uses the resulting instant. No date library: one small function, tested across a DST boundary. An invalid zone falls back to `Europe/Amsterdam`, logged once. Alternative: require the model to always send an offset; rejected because voice models often do not, and silently wrong answers are the failure Jarvis's validation was written to avoid.

**Request timeout.** Each TomTom request gets `AbortSignal.timeout(10_000)`, like `media`. An abort is a transport failure, so it becomes an `UpstreamRequestError` without status. Jarvis had none; a hung request would otherwise hold a voice turn until the tool timeout.

**Tests.** The three vitest files become `node:test` files under `modules/travel/test/` (`helpers`, `tomtom`, `travel-time`) with the same cases, plus a `module.test.ts` using `createTestHost` for the manifest (missing key fails the module), channels, the end-to-end tool call against a fake `fetch`, and the key never appearing in an error. Time-dependent tests pass `now` explicitly as Jarvis's did.

## Risks / Trade-offs

- [The module shows as `failed` on deployments without a TomTom key] → Same as `media` without Jellyfin; `FRIDAY_MODULES` can leave it out, and the error names the key.
- [The API key travels in the query string, so a proxy or TomTom-side log could see it] → TomTom offers no header auth for these endpoints; Friday never logs the URL. Same exposure as in Jarvis.
- [Geocode cache is per process and in memory] → Fine at household scale; a restart only costs a few extra lookups.
- [A fuzzy top match can be the wrong place] → Resolved names are returned so the model can say "to Schiphol-Rijk, 12 minutes" and the user can catch it.

## Migration Plan

Add `TOMTOM_API_KEY` in Settings > Configuration (or `friday-secrets`) after deploying, then reload the `travel` module. Rollback is reverting the merge; the module stores nothing. The Jarvis service can be retired separately.
