# Design

## Context

- `configListing` in `packages/core/src/app.ts` walks an entry's requesters (core first, then modules) and reports the first scope with a stored value (the requester's own scope, else `global`) as `scope`, with its `value` and `updatedAt`. Other rows for the same key are invisible.
- `ConfigStore.keys()` already returns every stored `(scope, key, secret, updatedAt)`; `ConfigStore.get(scope, key)` returns a plain or decrypted value.
- `DELETE /api/config/:scope/:key` already deletes any scope without checking it (only `PUT` validates the scope).
- The drawer (`ConfigurationPage.vue`) shows "stored for {scope}" and a footer `Clear` that deletes `selected.scope`.

## Goals / Non-Goals

**Goals:**
- Every stored copy of a key is visible and clearable from the portal.

**Non-Goals:**
- Changing resolution order or which scope `scope` reports.
- Warning in modules or logs about overrides.
- Bulk "move to global" actions; clear-then-save covers it.

## Decisions

**`stored` built from `ConfigStore.keys()` once per listing.** Group the rows by key, then attach them to each entry. For a plain row, include `value` from `ConfigStore.get`; for a secret row (by row flag or declared secret), never. Order: `global`, `core`, then by scope name. This is one extra `SELECT` per listing, the same query `keys()` already runs for undeclared globals. Alternative: query per entry and per requester. Rejected: more queries, and it would miss scopes of modules that no longer declare the key, which are exactly the leftovers worth clearing.

**Pure portal helpers in `src/lib/config-stored.ts`**, tested with `node:test` like `config-scope.ts`:
- `extraScopes(entry)`: how many stored scopes besides `entry.scope`, for the `global +1` cell.
- `overrides(entry)`: the stored module scopes (not `global`, not `core`) when `global` is also stored, for the "overrides global" marker and the save hint.

**Drawer layout.** A "Stored values" list replaces the "stored for {scope}" line: each row shows the scope, the value for plain entries, the relative update time, an "overrides global for {module}" note where it applies, and a small `Clear` button that deletes that scope. The footer `Clear` goes away, because per-row clearing covers it. When `draft.scope === "global"` and `overrides(selected)` is non-empty, a hint under the scope selector names the modules that keep their own value.

## Risks / Trade-offs

- [Listing responses grow a little for keys stored in several scopes] → Negligible: a household install has tens of keys.
- [The footer `Clear` moves into the list, so an existing habit changes] → The list sits right above the footer, and a key stored once still has exactly one `Clear`.
