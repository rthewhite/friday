# Proposal

## Why

The portal works but reads as a pile of cards and inline forms: every configuration key carries its own input row, shared keys appear once per module, tabs are plain text, and the sidebar is a flat list. Jarvis's config screen shows the same information as one dense table with a clear header, pill tabs with counts, and editing in a separate panel. Friday should adopt that layout so the portal reads as one calm system now that the features are in place.

## What Changes

- `@friday/portal-ui` gains the building blocks the redesign needs: `DataTable` (header row, hover, row click), `Tabs` (pill group with counts), `StatusDot`, `Drawer` (side panel for editing), an `eyebrow` slot on `PageLayout`, and `Chip`.
- The Configuration page becomes one table per tab. Each key appears once with status dot, key, description, "requested by" module chips, scope, and last updated. Clicking a row opens a drawer with the value field, scope selector, Save, Save and reload module, and Clear. The plain tab shows values in the row. "Add a global value" moves to a header action that opens the same drawer.
- `/api/config` returns one entry per key with a `modules` array (who declares it, with their `required` flags) and `updatedAt` from the store, instead of one entry per module.
- Remote modules page: keys in a `DataTable`, "New key" as a header action opening a drawer with the one-time display inside it.
- Modules page: one table row per module with status dot, kind, tools count, and an Open or Reload action; details on row click in a drawer.
- Sidebar: sections `Assistant` (Talk), `Modules` (Modules page and module UIs), `System` (Configuration, Remote modules), each with an uppercase section label; a small round mark next to the Friday name; consistent icons from a single small inline SVG set replacing emoji.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities
- `portal-shell`: navigation sections and header hierarchy; Modules page as a table with a detail drawer; shared components list.
- `secret-management`: configuration API entries keyed per key with `modules` and `updatedAt`; configuration page as table plus drawer.
- `remote-modules`: key management page uses the table and drawer pattern.

## Impact

- Portal and portal-ui only, plus a shape change in `configListing` and the `/api/config` response (`packages/core/src/app.ts`) and an `updated_at` read in `ConfigStore.keys()`. No storage, resolver, or SDK changes.
- Existing portal tests (components, generator) extend; API tests for the new listing shape.
