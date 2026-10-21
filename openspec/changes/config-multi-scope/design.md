# Design

## Context

Configuration lives in `config_values`, one row per `(scope, key)`. A scope is a module id, `core` or `global` (`packages/core/src/secrets/config-store.ts`). A module resolves its own scope, then `global`, then the environment (`resolver.ts`). Secret rows are AES-256-GCM encrypted with `scope:key` as associated data, so a ciphertext can't be moved to another scope as is. `PUT /api/config/:scope/:key` stores one value in one scope (`packages/core/src/app.ts`). The drawer in `ConfigurationPage.vue` has a single `<select>` and its default comes from `defaultScope()` in `packages/portal/src/lib/config-scope.ts`. Portal tests cover the `lib/` helpers only; the page has no component tests.

In-process modules run in Friday's process and `ctx.config.get` reads any key, declared or not. Remote modules receive no configuration. So keeping a value out of a module's scope organises config, but it isn't a security boundary against in-process code. It keeps `global` from reaching modules that don't need a value, and it will matter once configuration reaches anything less trusted.

## Goals / Non-Goals

**Goals:**
- Give the same value to a chosen set of requesters from one drawer, and update it the same way.
- Share an already stored secret without the user having it at hand, and without sending it to the browser.

**Non-Goals:**
- A shared row with an allow-list of modules (option 3 in the discussion). It would need a migration, a new resolution step, and grants similar to `oauth-connections`'.
- Restricting what an in-process module can `get`.
- Copying across keys (only the same key into another scope).
- Atomic multi-scope writes.

## Decisions

### One copy per scope, not a shared row

Saving for `media` and `sonos` writes two ordinary rows. Resolution, listing, `stored`, override and leftover marking, `Clear` and `onConfigChange` all keep working unchanged. Each copy is its own row, so a module can keep diverging later. The cost is that the copies can drift. The selector preselects every requester copy, so re-saving updates them all by default, and the table's `media +1` shows there is more than one copy. The alternative, one row plus a list of readers, gives a single source of truth, but every layer would need to learn the new row kind. That's too much for a two-module case.

### Copying happens on the server (`from`)

`PUT /api/config/sonos/HA_TOKEN { from: "media" }`: core reads the source through `ConfigStore.get(from, key)`, which decrypts under `from:key`, then stores the value through `set(to, key, value, { secret })`, which re-encrypts under `to:key`. A secret value never leaves the process, and the browser never sees it. The copy is secret when the source row is secret (`info(from, key).secret`) or the key is declared secret. That's the existing `isDeclaredSecret` rule plus the source's own kind, so copying can't turn a secret into plain. If `get` returns undefined while `info` reports a row, the source is unreadable (no master key, or decryption fails), and the API answers 503 instead of 404 so the user knows to re-enter the value. `ConfigStore` gets a small `copy(from, to, key, { secret })` that does this and returns `copied`, `missing` or `unreadable`, so the handler stays thin. `from` may be any scope that holds the key (also a leftover), in line with `DELETE`. The target keeps the existing validation: a loaded module, `core` or `global`.

The alternative was the drawer asking the user for the value again. That's the problem the user already ran into: Home Assistant tokens can't be shown again, so you have to create a new one.

### The drawer computes a save plan in `lib/`

`packages/portal/src/lib/config-scope.ts` holds the pure logic, so it is unit-tested like `defaultScope` is today:

- `defaultScopes(entry): string[]` returns the requesters (`entry.modules`) that appear in `entry.stored`, else `["global"]` when a global copy exists. With nothing stored it returns `[defaultScope(entry)]`, the current rule. A leftover scope is not a requester, so it is never preselected.
- `toggleScope(selected, scope): string[]` makes `global` and requesters exclude each other. Deselecting the last scope is allowed; Save is then disabled.
- `savePlan(entry, selected, value)` returns `{ writes: { scope, value? , from? }[], source?: string }`, or `null` when nothing can be saved:
  - with a value, every selected scope gets `{ value }`;
  - with an empty value, each selected scope without a copy gets `{ from: source }`, where source is the first selected scope with a copy, else `entry.scope`, else the first stored scope. If there's no source, or no selected scope lacks a copy, the result is `null`.

The page renders the plan's `source` as "Copies the value stored for media", sends the writes one after another, then reloads every selected module (excluding `global` and `core`) when asked. It collects which scopes succeeded and which failed, and shows those in the notice. The drawer stays open when something failed. The selector is a row of checkboxes, like the MCP servers tab's channels: one per requester, plus `global (all modules)` last. It stays readable at five requesters (`FRIDAY_TIMEZONE`). A failed save is shown inside the drawer as well, because the page notice sits behind it.

Writes go sequentially as separate PUTs rather than through a new batch endpoint. The API stays per scope, as the spec already describes it, and a partial failure is rare (the store is local SQLite). When it does happen, it is reported per scope.

### The `from` body shape

`from` is a sibling of `value` in the same PUT, not a separate `POST .../copy` route. The target is still `:scope/:key` and its validation is shared. `secret` is ignored with `from`, because the kind comes from the source and the declaration.

## Risks / Trade-offs

- [Copies drift: someone re-saves only one] → It is visible: the drawer lists each copy with its time, and the preselection includes all of them. Divergence is sometimes on purpose (override). It is not prevented.
- [Partial save: the first scope saved, the second failed] → The notice names both, the drawer stays open, and saving again is idempotent.
- [Copying a secret into `global` widens who reads it] → Only through an explicit selection of `global`. The drawer labels it `global (all modules)`. Same as typing the value there today.
- [Exclusive `global` stops someone from writing a global value and a module copy in one go] → Rare, and done in two saves. Keeping them apart avoids a save that silently overwrites an override.

## Migration Plan

No data migration. Deploy as usual. In production afterwards:

1. Open `HA_TOKEN`, keep `media` ticked, tick `sonos`, leave the value empty, and choose `Save and reload`.
2. Do the same for `HA_URL`.

`sonos` then loads. Rollback is a redeploy: copies are ordinary rows and keep working with the old code.
