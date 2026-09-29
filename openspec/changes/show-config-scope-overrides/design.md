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

**`stored` built from `ConfigStore.keys()` once per listing.** Group the rows by key, then attach them to each entry. For a plain row, include `value` from `ConfigStore.get`; for a secret row (by row flag or declared secret), never. Order: `global`, `core`, then by scope name. It reuses the single `keys()` scan the listing already runs for undeclared globals. Alternative: query per entry and per requester. Rejected: more queries, and it would miss scopes of modules that no longer declare the key, which are exactly the leftovers worth clearing.

**Pure portal helpers in `src/lib/config-stored.ts`**, tested with `node:test` like `config-scope.ts`:
- `scopeSummary(entry)`: the scope the table shows (the winning scope, else the first stored one) and the other stored scopes, for the `global +1` cell and its tooltip.
- `ownCopies(entry)`: stored scopes of the key's requesters (`entry.modules`, which includes `core`), since each requester reads its own scope before global. They drive the "overrides global" marker (when a global copy exists) and the save hint (whether or not one exists yet).
- `strayCopies(entry)`: stored scopes that do not request the key, marked "probably left over".

The first draft based overrides on the scope name alone (every non-global, non-core scope, and only when global was stored). Code review found three errors in that: no hint when saving global over a module-only copy (a spec scenario), leftovers labelled as overrides, and `core` copies not labelled at all. Using the requester list fixes all three.

**Scope column.** The table had no Scope column even though the Configuration page requirement lists one; this change adds it, as the home of `global +1`.

**Drawer layout.** A "Stored values" list replaces the "stored for {scope}" line: each row shows the scope and the value for plain entries on one line, and the marker and update time below, with a ghost `Clear` button that deletes that scope and keeps the drawer open on the refreshed entry. The footer `Clear` goes away, because per-row clearing covers it. When `draft.scope === "global"` and `ownCopies(selected)` is non-empty, a hint under the scope selector names the requesters that keep their own value.

**Not in scope:** a key stored only for a scope that no loaded module requests, with no global copy, is not listed (there is no entry to attach it to), so it cannot be cleared from the portal. Such rows only come from removed modules; `DELETE /api/config/<scope>/<key>` still clears them.

## Risks / Trade-offs

- [Listing responses grow a little for keys stored in several scopes] → Negligible: a household install has tens of keys.
- [The footer `Clear` moves into the list, so an existing habit changes] → The list sits right above the footer, and a key stored once still has exactly one `Clear`.
