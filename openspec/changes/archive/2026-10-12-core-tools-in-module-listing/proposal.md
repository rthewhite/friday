# Proposal

## Why

Since `device-alerts-and-timers`, core registers tools itself (`set_timer`, `list_timers`, `cancel_timer`, `snooze_alert`, owner `core`). `/api/modules` lists only modules, MCP servers and remote modules, so these tools appear nowhere in the portal: after the deploy the timers look like they are missing, although Friday has them.

## What Changes

- `GET /api/modules` lists core as an entry of its own when core owns tools: id `core`, label `Core`, status `loaded`, `tools` with the names of the tools core registered, no UI. It comes first, before the in-process modules.
- The Modules page shows that row with kind `core`, its tools in the drawer, and no `Reload` action (core can't be reloaded; `POST /api/modules/core/reload` answers 404 as before).
- Docs: the README's Modules page description and the `openspec/config.yaml` context mention the core entry.

### Non-goals

- Core's other parts (jobs, devices, alerts) as entries, or any status for them. The entry exists to show core's tools.
- Moving the timer tools into a module.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `http-server`: the module listing endpoint includes a `core` entry for the tools core owns.
- `portal-shell`: the Modules page shows the `core` row with kind `core`, without a reload action.

## Impact

- **Core:** `moduleListing` in `packages/core/src/app.ts` (reads `registry.names("core")`), its tests.
- **Portal:** `packages/portal/src/pages/ModulesPage.vue` (kind and reload rules), `ApiModule` in `packages/portal/src/composables/useModules.ts` if a field is needed; the page logic moves to a tested pure function in `packages/portal/src/lib/`.
- **Docs:** README (Portal section), `openspec/config.yaml` context.
- No API is removed and existing entries are unchanged. Clients that assume the first entry is a module (none in the portal) would see `core` first when core owns tools.
