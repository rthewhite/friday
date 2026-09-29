# Proposal

## Why

A configuration key can be stored in several scopes at once (for example `FRIDAY_TIMEZONE` for `global` and for `builtin`), and a module-scope value overrides the global one for that module. The configuration listing reports only one scope per key, so the portal shows the global value and hides the override. It also cannot clear the override: the drawer's `Clear` removes only the scope it shows. This happened on the homelab after `cron-follows-portal-timezone`: a `builtin`-only `FRIDAY_TIMEZONE` from before sat invisibly behind the new global value, and had to be deleted over the API from inside the pod.

## What Changes

- `GET /api/config` entries gain `stored`: every scope the key is stored in, each with `updatedAt` and, for plain values, `value`. Omitted when nothing is stored. The existing fields (`scope`, `value`, `updatedAt`, `status`) are unchanged.
- The configuration drawer lists the stored scopes, marks a module scope that overrides the global value for that module, and offers `Clear` per scope instead of one `Clear` for the shown scope.
- The table's scope column shows how many more scopes hold the key (`global +1`), so an override is visible without opening the row.
- When the user saves a key globally while a module scope still overrides it, the drawer says which modules keep their own value.

## Capabilities

### New Capabilities
<!-- None -->

### Modified Capabilities
- `secret-management`: the Configuration API listing reports every stored scope; the Configuration page shows them and clears each one.

## Impact

- Code: `packages/core/src/app.ts` (`configListing`), `packages/portal/src/pages/settings/ConfigurationPage.vue`, a new `packages/portal/src/lib/config-stored.ts` (pure helpers for ordering and override labels).
- Tests: `packages/core/test/platform-api.test.ts` (the exact-shape listing assertions gain `stored`, plus new cases), new `packages/portal/test/config-stored.test.ts`.
- No API removals: clients that ignore `stored` behave as before. No storage or migration changes.
- In flight: none.
