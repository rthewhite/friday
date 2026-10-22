# Design

## Context

Route components are lazy (`() => import("./pages/ChatPage.vue")` in `packages/portal/src/router.ts`; module UIs through `/m/:id`). Vite names chunks by content hash, and a deploy replaces them. A missing `/assets/*.js` falls through to core's SPA fallback, which answers `index.html`, so the import fails. Browsers word this differently:
- Chrome: "Failed to fetch dynamically imported module"
- Safari: "Importing a module script failed"
- Firefox: "error loading dynamically imported module"

## Goals / Non-Goals

**Goals:** a tab left open across a deploy recovers by itself on the next navigation, at the page the user asked for.

**Non-Goals:** noticing a new build before a navigation fails, such as polling for a version or showing an "update available" banner. Changing the server's fallback for missing assets is also out of scope; the import fails either way.

## Decisions

### 1. `router.onError`, not only `vite:preloadError`

Vue Router reports a failed lazy component to `router.onError(error, to)`, which carries the target route. Reloading with `location.assign(to.fullPath)` lands on the page the user clicked. Vite's `vite:preloadError` event fires earlier but knows only the current URL, so reloading there would leave the user on the old page. It also fires for preload failures the router would retry. The router handler is enough, because every lazy import in the portal is a route component.

Once any `onError` handler is registered, Vue Router stops logging navigation errors itself. The handler therefore `console.error`s every error it doesn't turn into a reload, so other failures stay visible as they were. The browser check caught this: the "Broken chunk" case was silent before that.

### 2. A pure helper with a guard in `sessionStorage`

`packages/portal/src/lib/stale-chunks.ts`:
- `isChunkLoadError(error)` matches the three browser messages, plus `ChunkLoadError` by name.
- `shouldReload(now, lastReloadAt)` returns true when there was no reload in the last 10 seconds.

The router handler records the reload time in `sessionStorage` under `friday:chunk-reload` before reloading. The guard is per tab and survives the reload itself, which is what stops a loop. Both functions are pure and covered by `node:test`, like the other `lib/` helpers.

## Risks / Trade-offs

- [A new browser wording isn't matched] → The page fails as it does today, and the user reloads. The matcher is in one place, with a test per known wording.
