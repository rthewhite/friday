## Why

The Jarvis import (change `brain-import`) was a one-off. It has run on the homelab: `rdewit`'s profile, 7 pages and 1 tombstone are in Friday's brain, matching Jarvis. The route, the script and the store methods only serve that import. Keeping them leaves an unused write path into the brain, and code and docs to maintain for nothing.

## What Changes

- **BREAKING** (unused): remove `POST /api/modules/brain/import` and its `not_empty` error code.
- Remove the import logic (`modules/brain/src/import.ts`) and the store methods only it used: `setImportedTimes`, `addTombstone`, and the `looseLinkTargets` helper in `links.ts`.
- Remove the script `modules/brain/scripts/import-jarvis.ts` with its reader `jarvis-export.ts`, and the package script `import-jarvis`.
- Remove their tests (`test/import.test.ts`, `test/import-jarvis.test.ts`).
- Remove the README section "Importing from Jarvis".
- The imported data stays as it is. Pages, revisions (noted `imported from jarvis`) and tombstones are ordinary brain data.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `brain`: the requirement "Jarvis's brain can be imported into an empty brain" is removed.

## Impact

- **Code:** `modules/brain/src/{import.ts, routes.ts, store.ts, links.ts}`, `modules/brain/scripts/{import-jarvis.ts, jarvis-export.ts}`, `modules/brain/package.json`, `modules/brain/test/{import.test.ts, import-jarvis.test.ts}`.
- **Docs:** `README.md`.
- **Data:** no migration and no change to stored data.
- **Rollback:** revert the change. The code is also in the archived change `2026-09-29-brain-import` and in git history, if an import is ever needed again.
