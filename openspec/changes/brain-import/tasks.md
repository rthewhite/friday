# Tasks

## 1. Store and route

- [x] 1.1 Add the import to `BrainStore` (design D2 and D3):
  - the dry-run report: counts, profile tokens against the budget, blocking problems per page, warnings;
  - the empty-brain guard (a new `not_empty` code, 409);
  - application in one transaction: profile, deleted pages as create then soft-delete, live pages in ascending Jarvis `updated_at` with one `user` revision each noted `imported from jarvis (created …, updated …)`, Jarvis's times written back, tombstones last (skipping ones that name an imported page).

  Verify with `test/import.test.ts` cases:
  - a dry run reports counts and changes nothing;
  - an import creates the pages, the deleted pages and the tombstones with the notes and times;
  - `brain_remember` on an imported tombstone is refused;
  - a non-empty brain is refused;
  - an over-long name and a shared alias are reported and a real import writes nothing;
  - the prompt index lists pages in Jarvis's recency order;
  - a deleted page may share a live page's name.
- [x] 1.2 Register `POST /api/modules/brain/import` mapping the report and errors to `{ applied, report }`, 400 `invalid` with the report, and 409 `not_empty`. Verify with `import.test.ts` cases via `host.request` for the dry run, the import, the 400 and the 409 shapes

## 2. Script

- [x] 2.1 Write `modules/brain/scripts/import-jarvis.ts` and the `import-jarvis` package script (design D4):
  - read a Jarvis SQLite copy read-only with `node:sqlite` for one user (default `rdewit`), splitting profile, live and deleted pages, parsing aliases, reading tombstones;
  - build the payload and refuse above 1 MB;
  - always dry-run first and print the report; `--apply` imports only when there are no problems.

  Verify with `test/import-jarvis.test.ts`: a temporary SQLite file with Jarvis's `documents` and `document_tombstones` tables (two users, a profile, live, deleted and tombstoned rows) yields the right payload for `rdewit` only. The payload reader is exported so the test can call it without HTTP
- [x] 2.2 Document the import in the README's Memory section (what is imported and not, the runbook commands from design D5, the empty-brain rule, turning the nightly pass off first to review). Verify the documented commands match the script's flags by running the script's `--help`

## 3. Integration

- [ ] 3.1 Run `pnpm -r build && pnpm -r typecheck && pnpm -r test` in the worktree and verify all pass
- [ ] 3.2 Rehearse the runbook against the real data:
  - make the read-only backup in the Jarvis pod and copy it out (ask the user before touching the pod);
  - run the dry run and then `--apply` against a local Friday with an empty data directory;
  - check in `/m/brain` that the counts match Jarvis's portal, the profile and a few pages read correctly, deleted pages are under "Recently deleted", and tombstoned names are refused by `brain_remember`;
  - delete the local copy afterwards.

  The homelab import itself happens after merge and deploy, with the user's go-ahead
