# Tasks

## 1. Reload on stale chunks

- [x] 1.1 Add `packages/portal/src/lib/stale-chunks.ts` with `isChunkLoadError(error)` and `shouldReload(now, lastReloadAt)`. Verify with `packages/portal/test/stale-chunks.test.ts`: the Chrome, Safari and Firefox messages and a `ChunkLoadError` are recognised; a guard error, a `TypeError` about something else and a non-error are not; a reload is allowed with no previous reload and 10 seconds after one, and refused 9 seconds after one
- [x] 1.2 Register `router.onError` in `createPortalRouter`: on a chunk load error that `shouldReload` allows, store the time under `friday:chunk-reload` in `sessionStorage` and `location.assign(to.fullPath)`; otherwise leave the error alone. Verify with `pnpm --filter @friday/portal typecheck` and `build`, and in headless Chrome against a local core: load the portal, delete the Chat chunk from `dist/assets` (as a deploy would replace it), click `Chat`, and see one reload to `/chat`. With the chunk still missing after the reload, see the error and no second reload
