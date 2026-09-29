## 1. Remove the import

- [x] 1.1 Remove the `POST import` route and `not_empty` from `routes.ts`, `not_empty` from `BrainErrorCode`, `setImportedTimes` and `addTombstone` from `store.ts`, `looseLinkTargets` from `links.ts`, and delete `src/import.ts`. Verify: `git grep -nE "not_empty|setImportedTimes|addTombstone|looseLinkTargets|runImport" modules/brain` finds nothing.
- [x] 1.2 Delete `scripts/import-jarvis.ts`, `scripts/jarvis-export.ts`, `test/import.test.ts` and `test/import-jarvis.test.ts`, and remove the `import-jarvis` package script. Verify: `pnpm --filter @friday/module-brain test` and `pnpm --filter @friday/module-brain typecheck` pass.
- [x] 1.3 Add a route test: `POST /api/modules/brain/import` is no longer a brain route (404). Verify: the test passes.

## 2. Docs and full run

- [ ] 2.1 Remove the README section "Importing from Jarvis". Verify: `git grep -n "import-jarvis" -- README.md modules` finds nothing.
- [ ] 2.2 Run `pnpm -r build && pnpm -r typecheck && pnpm -r test`. Verify: all green.
