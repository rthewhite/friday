# Tasks

## 1. Reload on stale chunks

- [x] 1.1 Add `packages/portal/src/lib/stale-chunks.ts` with `isChunkLoadError(error)`, `handleNavigationError(error, to, env)` (storage, location, history and logger injected) and `clearReloadMark(storage)`. Verify with `packages/portal/test/stale-chunks.test.ts`:
  - the Chrome, Safari and Firefox messages and Vite's "Unable to preload CSS" are recognised; a guard error, an unrelated `TypeError` and a non-error are not;
  - a stale tab reloads at the target once and marks it;
  - the same target failing again is logged and not reloaded;
  - clearing the mark allows a reload again;
  - the current URL reloads the document, with `replaceState` first when only the hash differs;
  - other errors are logged and never reload;
  - blocked storage logs the error instead of reloading.
- [x] 1.2 In `createPortalRouter`, call `handleNavigationError` from `router.onError` and `clearReloadMark` from `router.afterEach` after a successful navigation. In `main.ts`, mount the app even when `router.isReady()` rejects. Verify with `pnpm --filter @friday/portal typecheck` and `build`, and in headless Chrome against a local core, simulating a deploy by swapping the served build under an open tab:
  - clicking `Chat` reloads once to `/chat` and shows the new build's Chat page, and the mark is cleared;
  - with the new Chat chunk missing too, it reloads exactly once, then shows the sidebar, logs the error and keeps the mark.
  (Done: 8/8 checks.)
