# Design

## Context

See `proposal.md` for the motivation. `moduleListing()` in `packages/core/src/app.ts` builds `/api/modules` from `host.loaded()`, the MCP servers and the connected remotes. Core registers its timer tools in `server.ts` with owner `core` (`TOOL_OWNER` in `packages/core/src/alerts/tools.ts`); the registry already answers `names(owner)`. `core` is a reserved module id, and the Configuration page already calls core's keys `Core` (`coreManifest` in `core-config.ts`). The Modules page decides a row's kind and reload action from its id and status (`ModulesPage.vue`), so as it stands a `core` row with status `loaded` would be called `in-process` and offered `Reload`.

## Goals / Non-Goals

**Goals:**
- Core's tools visible on the Modules page, with no change to any existing entry.
- The page's row rules (kind, reload) tested, which they aren't today.

**Non-Goals:**
- A status for core's services; the entry only carries tools.

## Decisions

### 1. Build the entry from the registry, in `moduleListing()`

`moduleListing()` gets the registry (already in `AppDeps`) and prepends `{ id: "core", label: coreManifest.label, description, status: "loaded", tools: registry.names("core"), ui: false }` when that list isn't empty.

- **Why the registry:** it is the single source of which tools core owns, so a future core tool shows up without touching the listing.
- **Why only with tools:** an entry without tools says nothing, and tests and setups without the alert tools keep exactly today's listing.
- **Alternative: a `core` row from the host, like a module.** Rejected: core isn't loaded, disabled or reloaded like one, and the host would have to know about core's tools.

### 2. Recognise the row by id in the portal

The page treats id `core` as kind `core` and never reloadable. The id is reserved for core (modules can't take it), so the check is exact. The kind and reload rules move from `ModulesPage.vue` into a pure function in `packages/portal/src/lib/modules.ts`, tested like `lib/devices.ts`.

- **Alternative: a `kind` field in the API.** It would be cleaner long term, but means changing every entry's shape; the page already derives kind from id and status.

## Risks / Trade-offs

- **[A client relied on the first entry being a module.]** → Only tests did, and they don't register core tools. The portal looks entries up by id.
