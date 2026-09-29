# Proposal

## Why

Friday's brain is live but empty. What the household has built up in Jarvis's brain should carry over, so Friday starts with the people, places and projects it already knows about instead of relearning them. Jarvis stores the same kind of memory: markdown pages per entity, one profile, soft delete, tombstones and `[[links]]`. A faithful one-off import is therefore straightforward. The only real mismatch is that Jarvis scopes everything per user, and only user `rdewit` moves over.

## What Changes

- **New route `POST /api/modules/brain/import`** takes a Jarvis export and applies it to an empty brain, in one transaction, through the brain store:
  - Input: the profile, the live pages, the soft-deleted pages and the tombstoned names.
  - The profile body replaces Friday's empty profile.
  - Live pages become pages. Soft-deleted pages become soft-deleted pages, so they show under "Recently deleted".
  - Tombstoned names become tombstones, so neither `brain_remember` nor the nightly pass recreates a page that was deliberately forgotten.
  - Each imported page gets one revision with author `user`, noted as imported from Jarvis. Pages keep Jarvis's created, updated and deleted times, so "most recently updated" stays as it was. Jarvis's revision history is not imported and stays in Jarvis.
  - It is refused when the brain isn't empty (any page other than an empty profile), so an import can't mix into or duplicate existing memory.
  - A dry run validates the whole export against Friday's page rules without writing anything, and reports problems:
    - names that are too long;
    - too many aliases;
    - bodies that are too long;
    - name collisions within the import;
    - tombstones that name an imported page;
    - `[[links]]` Friday won't recognise.
  - A real import with any blocking problem writes nothing.
- **New script `modules/brain/scripts/import-jarvis.ts`**:
  - It reads a copy of Jarvis's SQLite file read-only and selects one user (`rdewit` by default).
  - It builds the export, and sends it as a dry run to a Friday base URL, printing the report.
  - With `--apply`, it imports when the dry run is clean.
- **Runbook:**
  - Copy the live Jarvis database safely, with `better-sqlite3`'s backup API inside the pod, streamed out over `kubectl exec`.
  - Import into a local Friday first to review it in the portal, then into the homelab.

Out of scope: other Jarvis users, Jarvis's revision history and source conversation ids, Jarvis's legacy fact rows (the `memories` table, already converted to pages by Jarvis itself), Jarvis's conversations, and any continuous sync.

## Capabilities

### New Capabilities

<!-- None: importing is a brain requirement. -->

### Modified Capabilities

- `brain`: adds a requirement for importing Jarvis's brain into an empty brain.

## Impact

- **Module `modules/brain`:**
  - An import function in the store that creates pages, soft-deleted pages and tombstones on one path.
  - The route.
  - The script, plus a `package.json` script entry to run it.
  - Tests.
- **No schema change.** The existing `brain__pages`, `brain__revisions`, `brain__names` and `brain__tombstones` tables hold everything.
- **The first nightly pass after the import** sees every imported page as changed and consolidates the brain. Its changes are reviewable and revertible in the `Nightly` tab. A brain larger than the pass's 60000-character input is worked through over several nights.
- **HTTP:** one new write route. Core's cross-origin write refusal covers it, and it only acts on an empty brain. The export can be up to 1 MB, which is core's request body limit.
- **Privacy:** the exported SQLite copy holds private memories. The runbook keeps it outside the repo and deletes it afterwards.
- **Docs:** the README's Memory section gains how to import from Jarvis.
