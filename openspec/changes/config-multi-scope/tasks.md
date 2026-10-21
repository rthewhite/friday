# Tasks

## 1. Copy a stored value on the server

- [x] 1.1 Add `ConfigStore.copy(from, to, key, { secret })` in `packages/core/src/secrets/config-store.ts`. It reads the source through `get` (decrypting under `from:key`) and writes it through `set` (re-encrypting under `to:key`). It returns `"copied"`, `"missing"` (no row) or `"unreadable"` (a row whose value can't be read). Verify with new cases in `packages/core/test/secrets.test.ts`:
  - a secret copied to another scope reads back the same and is ciphertext on disk under the new scope;
  - a plain value copies as plain;
  - a missing source returns `"missing"`;
  - with a wrong master key, or none, a secret source returns `"unreadable"` and writes nothing.
- [x] 1.2 Accept `{ from }` in `PUT /api/config/:scope/:key` (`packages/core/src/app.ts`):
  - `value` and `from` together, or neither, gives 400;
  - a missing source gives 404;
  - an unreadable source gives 503 with a message;
  - the copy is secret when the source is secret or the key is declared secret;
  - target validation is unchanged;
  - `notifyConfigChange` is called for the target.

  Verify with `packages/core/test/platform-api.test.ts`: every new scenario under "Configuration API" (copy a secret, with no value in the response and the copy encrypted; copy a plain value; source without the key; value and from together; unreadable secret source), plus a copy reported to `onConfigChange` for the target scope. Then `pnpm --filter @friday/core test` and `pnpm --filter @friday/core typecheck`.

## 2. Multi-select scopes in the drawer

- [x] 2.1 In `packages/portal/src/lib/config-scope.ts`, add three helpers. Keep `defaultScope` as the nothing-stored rule:
  - `defaultScopes(entry)`: the requesters holding a copy, else `["global"]` if there's a global copy, else `[defaultScope(entry)]`;
  - `toggleScope(selected, scope)`: global and the requesters exclude each other;
  - `savePlan(entry, selected, value)`: writes with `value` or `from`, the `source`, and `null` when nothing can be saved.

  Verify with `packages/portal/test/config-scope.test.ts`. It needs the preselection scenarios: shared key defaults to global, single requester, reopen a module-scoped value, reopen a value stored for two modules, and a leftover that is never preselected. It also needs global and modules excluding each other. For `savePlan`, cover:
  - save for two modules;
  - share a stored secret without retyping (one write `{ from: "media" }` to `sonos`, nothing for `media`);
  - the source fallbacks (first selected copy, then `entry.scope`, then the first stored);
  - `null` for an empty value when nothing is stored or every selected scope has a copy;
  - `null` for an empty selection.
- [x] 2.2 In `ConfigurationPage.vue`, replace the scope `<select>` with checkbox chips: one per requester, plus `global (all modules)`.
  - The drawer preselects with `defaultScopes`.
  - `Save` runs the `savePlan` writes in order. `Save and reload` reloads every selected module (not `global`/`core`) and is labelled with their names.
  - The "Copies the value stored for X" hint appears when the plan copies.
  - The notice names saved and failed scopes, and the drawer stays open on failure.
  - The existing "keeps its own value" and `core` hints work with the selection.
  - Clearing a copy re-derives the selection.

  Verify with `pnpm --filter @friday/portal test`, `typecheck` and `build`. Then, on a dev server on a free port, walk the Configuration page scenarios for `HA_URL`/`HA_TOKEN` with a local `media` copy: save for two modules, share a stored secret without retyping, rotate, global/module exclusion, deselecting keeps the copy, saving globally over an override. Check the results in `GET /api/config`.

## 3. Docs

- [x] 3.1 Update the README configuration paragraph (scope one value to one module, several modules or global; empty value copies a stored one) and the Sonos setup line (store `HA_URL`/`HA_TOKEN` for `media` and `sonos`, or globally). Also update the `.env.example` HA comment and the scope description in the `openspec/config.yaml` context (`defaultScopes`, `savePlan`, `PUT { from }`). Verify by reading the diff and running `pnpm --filter @friday/core test`, which checks `.env.example`.

## 4. Integration

- [x] 4.1 Run `pnpm -r build && pnpm -r typecheck && pnpm -r test` in the worktree. Verify it is green
- [ ] 4.2 After the merge and deploy, in production: share `HA_TOKEN` and `HA_URL` from `media` to `sonos` with an empty value and `Save and reload`. Verify that `sonos` shows `loaded`, `media` stays `loaded`, and `GET /api/config` lists `media` and `sonos` for both keys
