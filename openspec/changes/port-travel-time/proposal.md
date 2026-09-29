# Proposal

## Why

Jarvis could answer "how long to drive to the office?" with live traffic through its `travel-time` tool (TomTom). Friday cannot, and a household voice assistant gets asked this all the time. The Jarvis tool is small, well-tested and already debugged against TomTom's quirks, so porting it is cheaper and safer than writing a new one.

## What Changes

- New in-process module `modules/travel` (package `@friday/module-travel`, id `travel`) with one tool, `get_travel_time`, offered on voice and chat.
- The tool takes `origin` and `destination` (place name, address, POI or `lat,lon`) and optionally `departAt` or `arriveAt` (never both). It returns car travel time with live or predicted traffic: the resolved place names, duration in seconds and as speech-friendly text, distance, traffic delay, and departure and arrival times.
- Behaviour carried over from Jarvis: coordinate pairs skip geocoding; geocode results (hits and misses) are cached for 24 hours, route results never; time arguments are validated before any request; a past `departAt` is refused; distinct errors for a rejected API key (with TomTom's wording), no route found, a location that matched nothing (naming which parameter) and other upstream failures; the API key is never logged or echoed.
- Differences from Jarvis: config comes from `ctx.config` (`TOMTOM_API_KEY`, required, secret) instead of the Jarvis config service; bare local times (no offset) are read in `FRIDAY_TIMEZONE` instead of the server process's zone (the container runs in UTC); TomTom requests time out instead of hanging; tests move from vitest to `node:test`; logging goes through `ctx.log`. No Dockerfile or Deployment of its own: it ships in the Friday image.
- Wiring: registered in `packages/core/src/modules.ts` and as a core dependency, its `package.json` copied in the `Dockerfile`, documented in the README and `.env.example`, `deploy/k8s.yaml` comment and the `openspec/config.yaml` context updated.

## Capabilities

### New Capabilities
- `travel-time`: driving travel time between two places with traffic, via TomTom, as the `travel` module's `get_travel_time` tool.

### Modified Capabilities
<!-- None: the module uses the existing module-system contract unchanged. -->

## Impact

- New: `modules/travel/` (src, test, package.json, tsconfig.json).
- Edited: `packages/core/src/modules.ts`, `packages/core/package.json`, `pnpm-lock.yaml`, `Dockerfile`, `README.md`, `.env.example`, `deploy/k8s.yaml` (comment only), `openspec/config.yaml` (context).
- External: TomTom Orbis Maps APIs (Places Search v1, Routing v2), needing an API key with the Routing and Places Search entitlements. No new npm dependencies (Jarvis used zod; Friday tool schemas use `Type` from `@friday/sdk`).
- Tool count grows by one.
