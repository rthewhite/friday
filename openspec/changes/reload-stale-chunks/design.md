# Design

## Context

Route components are lazy (`() => import("./pages/ChatPage.vue")` in `packages/portal/src/router.ts`; module UIs through `/m/:id`). Vite names chunks by content hash, and a deploy replaces them. A missing `/assets/*.js` falls through to core's SPA fallback, which answers `index.html`, so the import fails. The error depends on the browser and the file:
- Chrome: "Failed to fetch dynamically imported module"
- Safari: "Importing a module script failed"
- Firefox: "error loading dynamically imported module"
- Vite's preload helper, for a page with its own stylesheet: "Unable to preload CSS for …"

## Goals / Non-Goals

**Goals:** a tab left open across a deploy recovers by itself on the next navigation, at the page the user asked for, and a page that is really broken never reloads in a loop.

**Non-Goals:** noticing a new build before a navigation fails, such as polling for a version or showing an "update available" banner. Changing the server's fallback for missing assets is also out of scope; the import fails either way.

## Decisions

### 1. `router.onError`, not `vite:preloadError`

Vue Router reports a failed lazy component to `router.onError(error, to)`, which carries the target route, so the reload lands on the page the user clicked. Vite's `vite:preloadError` event fires earlier but knows only the current URL. Every lazy import in the portal is a route component, so the router handler covers them all.

Once any `onError` handler is registered, Vue Router stops logging navigation errors itself. The handler therefore logs every error it doesn't turn into a reload. The first browser check caught this: the broken-chunk case was silent.

### 2. Guard: once per target until a navigation succeeds

The handler stores the target (`to.fullPath`) under `friday:chunk-reload` in `sessionStorage` before reloading. A failure for the target already stored is logged, not reloaded. `router.afterEach` clears the mark after any successful navigation, so a later deploy can reload the same page again.

*Alternative, which was built first:* a 10-second time window. Rejected after review. On a slow connection a reload plus startup can take longer than the window, and a broken page would then reload forever.

When `sessionStorage` throws (storage blocked), the handler can't keep the mark. It doesn't reload; it logs the original error.

### 3. Reloading at the target

If the target's path and query differ from the current URL, the handler uses `location.assign(target)`. That is the case for every in-app navigation, because the router changes the URL only after the page loaded.

If they are the same, which is the case on the first navigation after loading the portal, it uses `location.reload()`. When only the hash differs, the target is put in the address bar with `history.replaceState` first, because `assign` would only move to the fragment.

`assign` adds a history entry like a normal click. The router doesn't tell the handler whether the failed navigation was a push or a replace, so a replace becomes a push in this rare case.

### 4. Testable handler, shell always mounts

`packages/portal/src/lib/stale-chunks.ts` holds `isChunkLoadError`, `handleNavigationError(error, to, env)` and `clearReloadMark(storage)`. `env` carries storage, location, history and the logger, so the decision is covered by `node:test` with fakes.

`main.ts` mounts the app even when `router.isReady()` rejects. A page that fails on the first navigation then leaves an empty page area under a working sidebar, not a blank tab.

## Risks / Trade-offs

- [A new browser wording isn't matched] → The page fails as it does today, and the user reloads. The matcher is in one place, with a test per known wording.
