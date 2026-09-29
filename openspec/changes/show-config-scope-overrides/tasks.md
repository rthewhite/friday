# Tasks

## 1. API lists every stored scope

- [x] 1.1 In `configListing` (`packages/core/src/app.ts`), add `stored` to entries with at least one stored row: `{ scope, updatedAt, value? }` per row from `ConfigStore.keys()`, value only for plain, non-declared-secret rows, ordered `global`, `core`, then by name, including scopes no loaded module declares; update the exact-shape listing assertions in `packages/core/test/platform-api.test.ts` and add tests for: a key stored globally and for one module (both listed, global first, values shown), a secret stored in two scopes (no values in `stored`), an env-only entry (no `stored`), a row for an unknown scope (listed), and `DELETE` of one scope leaving the other; verify `pnpm --filter @friday/core test` and `typecheck` pass

## 2. Portal shows and clears each stored scope

- [x] 2.1 Add `packages/portal/src/lib/config-stored.ts` with `extraScopes(entry)` and `overrides(entry)`, and `packages/portal/test/config-stored.test.ts` covering: one stored scope (0 extra, no overrides), global plus a module (1 extra, that module overrides), a module only (no overrides), global plus `core` (core is not a module override); verify `pnpm --filter @friday/portal test` passes
- [x] 2.2 In `ConfigurationPage.vue`, show `global +N` in the scope cell, replace "stored for {scope}" and the footer `Clear` with a "Stored values" list (scope, plain value, update time, override note, per-scope `Clear` via `DELETE /api/config/:scope/:key`), and add the hint under the scope selector when saving globally over overrides; verify `pnpm --filter @friday/portal typecheck` and `build` pass

## 3. Documentation

- [x] 3.1 Update the README (Configuration section and the jobs "Time zone" bullet) to say the drawer lists every stored scope and can clear a module override, and the `openspec/config.yaml` context line on `/api/config` to mention `stored`; verify by reading the diff

## 4. Integration

- [ ] 4.1 Run `pnpm -r build && pnpm -r typecheck && pnpm -r test`; verify all green
- [ ] 4.2 Start the built core on a free port with a scratch data dir, store `FRIDAY_TIMEZONE` globally and for `builtin` through the API, check that `/api/config` lists both in `stored` (global first) and that `DELETE /api/config/builtin/FRIDAY_TIMEZONE` leaves only global; stop the server afterwards
