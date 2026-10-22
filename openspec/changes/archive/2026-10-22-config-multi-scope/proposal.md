# Proposal

## Why

The configuration drawer can save a value for one module or for `global` (all modules), nothing in between. `HA_URL` and `HA_TOKEN` are needed by `media` and `sonos` and nothing else, but the only way to give both modules the same value is to make it global. Production holds them for `media` only, so `sonos` fails to load. Fixing that today means pasting the Home Assistant token again, because a stored secret can't be read back.

## What Changes

- The drawer's scope selector becomes a multi-select: a checkbox per requester of the key (modules and `core`) and `global (all modules)`. Global excludes the others: ticking it clears the module ticks, and ticking a module clears global.
- `Save` writes the value to every ticked scope, one stored copy per scope. `Save and reload` reloads every ticked module. Unticking a scope does not delete its copy; `Clear` still does that per copy.
- The selector preselects the requesters that hold a stored copy, else `global` when a global copy exists. With nothing stored it keeps today's default: the only requester, or `global` when several requesters share the key.
- Sharing a stored value with more scopes doesn't need the value again. When the value field is left empty, `Save` copies the stored value into the ticked scopes that don't have one yet. This also works for secrets. The copy is made on the server, so a secret still never reaches the browser.
- `PUT /api/config/:scope/:key` also accepts `{ from: "<scope>" }`, which copies the value stored in that scope instead of taking a `value`. The target is stored secret when the source is secret or any module declares the key secret.

Not changing: how modules resolve config (own scope, then global, then the environment), the data model and the per-scope rows. There is no shared row with a module list. Two copies are two rows, and rotating a token means saving it once with both scopes ticked.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `secret-management`: the Configuration API gains copying from another scope (`from`), and the Configuration page's scope selector becomes a multi-select with copy-on-save.

## Impact

- `packages/core/src/app.ts`: the `PUT /api/config/:scope/:key` handler accepts `from`. `packages/core/src/secrets/config-store.ts`: a `copy(from, to, key, opts)` that decrypts and re-encrypts under the target scope's associated data. Tests in `packages/core/test/platform-api.test.ts` and `secrets.test.ts`.
- `packages/portal/src/pages/settings/ConfigurationPage.vue`: checkboxes, saving and reloading per ticked scope, the copy hint. `packages/portal/src/lib/config-scope.ts`: `defaultScope` becomes `defaultScopes` (a list), plus a helper that plans which scopes get the typed value and which get a copy. Tests in `packages/portal/test/config-scope.test.ts`.
- Docs: the README's configuration paragraph, and its Sonos setup line ("store them for media and sonos, or globally"). `.env.example` (the HA comment) and the `openspec/config.yaml` context where it describes scopes.
- No migration, no new environment variables, no new dependencies.
- Overlap: `agents` (which edited `ConfigurationPage.vue`) is already merged. `oauth-connections` adds its own page and leaves `ConfigurationPage.vue` and the config API handlers alone. Both changes add routes to `app.ts`, so a rebase there is mechanical.
