# Design

## Context

See proposal.md for the motivation. The facts that shape the approach:

- **Jarvis's brain** (`/Users/rdewit/Projects/jarvis/packages/brain`, schema in `src/db/database.ts`) is one SQLite file, `/data/jarvis-brain-memories.db`, in pod `jarvis-brain` (namespace `jarvis`, one replica, WAL mode). The tables that matter:
  - `documents`: `id`, `username`, `name`, `type` (`person|place|project|other`), `aliases` (JSON), `body`, `is_profile`, `deleted_at`, `created_at`, `updated_at`.
  - `document_tombstones`: `username`, `name_lower`, `purged_at`.
- **Jarvis has no export, and its API is incomplete.** Its REST API needs Authentik's user header and doesn't expose tombstones or deleted bodies. Its image is `node:20-alpine` with `better-sqlite3` and no `sqlite3` CLI.
- **Jarvis enforces fewer rules than Friday.** Name and alias uniqueness is per user and enforced in code. There are no length limits on names or aliases. Its link pattern is `[[…]]` without a length limit.
- **Friday's brain store** (`modules/brain/src/store.ts`):
  - Every write goes through `writeRevision`, which validates fields (names 1 to 80 characters, at most 20 aliases, body at most 20000 characters) and keeps names unique through `brain__names`.
  - A `user` write lifts tombstones on the names it uses.
  - `updated_at` orders the prompt index.
- **Core's limits:** module routes read at most 1 MB of request body. The portal has no login, and core refuses cross-origin writes to `/api`.
- **Friday's live brain holds only its empty profile** (confirmed by the user).

## Goals / Non-Goals

**Goals:**
- One command imports `rdewit`'s Jarvis brain faithfully: names, aliases, types, bodies, the profile, soft-deleted pages, tombstones, and the recency order.
- Nothing is written unless all of it can be written.
- Problems are visible before anything is written.

**Non-Goals:**
- Merging into a non-empty brain, or running more than once. The empty-brain guard makes a second run a refusal.
- Fixing Jarvis data automatically. Blocking problems are reported for the user to fix in Jarvis (or in the export) and re-run.
- A portal UI for importing. It is a one-off, run by the developer.

## Decisions

### D1. A route plus a script, not a script writing to `friday.db`

The route `POST /api/modules/brain/import` applies the export through `BrainStore` inside one `ctx.db.transaction`. The script (`modules/brain/scripts/import-jarvis.ts`) only reads Jarvis's file and talks to that route.

- **Why:**
  - The store's validation and name uniqueness apply unchanged.
  - The same path works against a local Friday and the homelab.
  - The route can be tested with the test host.
- **Rejected alternatives:**
  - Writing to Friday's `friday.db` from the script: it bypasses the store's guards, needs the file (a PVC in k8s), and races the running pod.
  - Using Jarvis's REST API as the source: it lacks tombstones and deleted bodies, and needs Authentik.

### D2. The import payload and report

Request:

```
{ dryRun: boolean,
  profile?: { body, aliases? },
  pages:   [{ name, type, aliases, body, createdAt, updatedAt }],
  deleted: [{ name, type, aliases, body, createdAt, updatedAt, deletedAt }],
  tombstones: [{ name, purgedAt }] }
```

Response:

```
200 { applied: boolean, report }
400 { error, code: "invalid", report }
409 { error, code: "not_empty" }
```

`dryRun` defaults to true: only an explicit `dryRun: false` imports, so a request that forgets the flag can't write.

`report` is:

```
{ counts: { profile, pages, deleted, tombstones },
  profileTokens, budgetTokens,
  problems: [{ page, message }],
  warnings: [{ page?, message }] }
```

- **Blocking problems:**
  - `validateFields` failures: a name or alias invalid or too long, more than 20 aliases, a body over 20000 characters, an unknown type. Each is reported with the page's name as Jarvis had it.
  - A name or alias key used by two live imported pages, or by a live page and the profile.
  - A missing or malformed field.
- **Warnings:**
  - Aliases dropped by deduplication (for example an alias equal to the name).
  - A tombstone whose key is also an imported page's name or alias; that tombstone is skipped.
  - An imported page whose name or alias this brain had already tombstoned; the import brings it back.
  - `[[…]]` targets that aren't links under Friday's rules (over 80 characters or containing a line break); they stay as text.
  - A profile over its token budget; it is imported anyway, as the budget is soft.
- **Deleted pages** are validated with the same field rules. Their names may repeat live names, as in Jarvis, because a deleted page doesn't hold its names.

### D3. Application order inside the transaction

1. **Guard:** refuse with `not_empty` when `brain__pages` has any row besides the profile, or the profile has a body or aliases.
2. **Deleted pages:** `create`, then mark deleted directly with Jarvis's `deleted_at`, removing the page's names as a soft delete does, but without a second revision. That keeps every imported page at exactly one revision. Oldest first; each frees its names before the next page, so deleted and live pages that share a name don't collide. They go first, before the profile and live pages claim their names.
3. **Profile:** save its body and aliases (author `user`, note `imported from jarvis`).
4. **Live pages:** `create`, in ascending Jarvis `updated_at`. Each gets one revision (author `user`, note `imported from jarvis (created <c>, updated <u>)`).
5. **Times:** overwrite each imported page's `created_at` and `updated_at`, and a deleted page's `deleted_at`, with Jarvis's values. This is a direct update of those columns in the same transaction. Revision times stay at the import, so the history shows when the page arrived in Friday.
6. **Tombstones:** insert each one not skipped under D2, keyed by Friday's name key of Jarvis's `name_lower`, with Jarvis's purge time. This goes through a new store method used only by the import. Tombstones are written last, because a `user` create lifts tombstones on its names.

- **Store errors:** any error, such as a collision the dry run missed, rolls the whole import back. The route answers 400 `invalid` with the error added to the report's problems.
- **Why keep Jarvis's times:** the prompt index and the portal list order by recency, and creating pages one after another in the same millisecond would order ties by random id. Keeping the times is faithful and deterministic.

### D4. The script

The script is run as `pnpm --filter @friday/module-brain import-jarvis --db <copy.db> [--user rdewit] [--friday http://localhost:8080] [--apply]`.

- **Reading:** it opens the copy with `node:sqlite` in read-only mode. It selects `documents` and `document_tombstones` for the user, splits the rows into profile, live and deleted, and parses the aliases JSON. It never reads the `memories` or `document_revisions` tables.
- **Dry run first, always:** it posts `dryRun: true` and prints the counts, the profile size against the budget, problems and warnings. With `--apply`, and only when there are no problems, it posts again without `dryRun` and prints the result.
- **Size check:** it refuses to send a payload over 1 MB (core's body limit) and says so. Splitting the import would break its all-or-nothing rule.
- **Friday URL:** `--friday` defaults to `http://localhost:8080`. It sends no `Origin` header, like `curl`, so core's cross-origin write refusal doesn't apply.

### D5. Runbook

Run from the developer machine:

1. **Copy Jarvis's brain consistently:** use the backup API of the `better-sqlite3` already in the image. This works while Jarvis runs, in WAL mode, without stopping it.
   ```sh
   ssh rdewit@192.168.1.81 'sudo -n kubectl -n jarvis exec deploy/jarvis-brain -- node -e "require(\"better-sqlite3\")(\"/data/jarvis-brain-memories.db\",{readonly:true}).backup(\"/tmp/brain-export.db\").then(()=>console.log(\"ok\"))"'
   ssh rdewit@192.168.1.81 'sudo -n kubectl -n jarvis exec deploy/jarvis-brain -- cat /tmp/brain-export.db' > ~/jarvis-brain-export.db
   ssh rdewit@192.168.1.81 'sudo -n kubectl -n jarvis exec deploy/jarvis-brain -- rm /tmp/brain-export.db'
   ```
2. **Rehearse locally:** start a local Friday with an empty data directory, dry-run and apply against it, and review in `/m/brain`.
3. **Homelab:** dry-run against `https://friday.thewhite.nl`. Check that the counts match the rehearsal, then `--apply`.
4. **Clean up:** delete `~/jarvis-brain-export.db` and the local data directory.

## Risks / Trade-offs

- **[Risk]** Jarvis data breaks Friday's rules, for example a very long name. → The dry run names each problem. The user fixes it in Jarvis's portal and re-exports, or edits the copy. Nothing is half-imported.
- **[Risk]** The export is over 1 MB. → The script says so before sending. At household scale this is unlikely (Jarvis's own comments describe the brain as one small payload). If it happens, the design needs revisiting (a raised limit for this route) rather than a silent split.
- **[Risk]** The first nightly pass rewrites much of the imported brain at once. → That is its job, and the changes are reviewable and revertible in the `Nightly` tab. To review first, set `BRAIN_NIGHTLY_CRON=off` before the import and turn it back on later.
- **[Trade-off]** Jarvis's revision history and sources are not carried over. → Accepted: the user asked for the current state. Jarvis's database stays where it is, for reference.
- **[Risk]** Someone calls the route on a non-empty brain. → Refused by the guard. The route only ever adds data to an empty brain, so it can't overwrite or delete memory.

## Migration Plan

- **Deploy:** ship the change as usual. There is no schema migration.
- **Run** the runbook (D5).
- **Rollback:**
  - Before the import, nothing to do.
  - After it, delete and purge the imported pages in the portal.
  - Or restore `friday.db` from before the import, if the homelab has a backup of the PVC.
