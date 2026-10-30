# Design

> From an explore session on 2026-10-29/30. The decisions below were confirmed with the user. "Proposed" items are mine, open to change while writing the specs.

## Context

See proposal.md for the motivation.

- **Owner tags.** Every tool in the `ToolRegistry` carries the tag of whoever registered it:
  - an in-process module's manifest id;
  - `mcp:<server>` for an MCP server's tools;
  - `remote:<id>` for a remote module's tools;
  - `core` for core's own.
- **The only per-user rule is `ownerOnly`.** `declarations(channel, user)` and `callTool` check it through `setOwnerCheck`. `callTool` refuses, not only hides, a tool the caller may not use.
- **Each surface has one generic choke point that knows both the owner tag and the user:**
  - prompt context: `PromptContext.render` keeps its providers per owner tag;
  - module routes: `moduleRoute` in `app.ts`;
  - the module listing: `moduleListing` in `app.ts`. It drives the portal menu (`navItems` through `hasPage`) and the `/m/:id` gate, and isn't per user today.
- **Who the user is:**
  - a chat turn: the logged-in user, every turn;
  - a Talk session: the logged-in user, snapshotted when the session opens;
  - a voice device: the owner, snapshotted when the session opens;
  - an agent run: the agent's creator.
- **Module enablement** (`module_enablement`, `ModuleHost.setEnabled`) is global and unloads the module. MCP servers already have per-server `include`, `exclude` and `channels`. Remote modules have no settings.
- **Hand-written owner checks:** calendar has its own route and prompt checks. `per-user-calendars` removes them, and this change leaves calendar alone.

## Goals / Non-Goals

**Goals:**
- One access rule per owner tag that every surface honours, so a module can't be reached around it.
- Members can use Home Assistant without being able to administer it.
- No change for anyone until an admin sets something.

**Non-Goals:**
- Groups of users or roles as access targets: the chosen users are individual users.
- Per-calendar visibility (`per-user-calendars`) and per-user accounts.
- Reading MCP tool annotations (`readOnlyHint`, `destructiveHint`). A possible later option, once we know Home Assistant's server sends them.

## Decisions (confirmed)

| # | Decision |
|---|---|
| D1 | Admins set, per module (in-process, MCP server, remote module), whether everyone or only chosen users may use it. |
| D2 | Within a module, an admin can mark tools as "only for chosen users" (option B). This is how Home Assistant stays usable for members while restarting, deleting and config edits are not. |
| D3 | Voice devices act as the owner, so they get the owner's access. |
| D4 | Calendar's visibility is not part of this change (`per-user-calendars`). |

## Decisions (proposed)

**P1. One access record per owner tag.**
- **Storage:** a core migration adds:
  - `module_access(owner TEXT PRIMARY KEY, mode TEXT NOT NULL, restricted_json TEXT NOT NULL DEFAULT '[]', known_json TEXT NOT NULL DEFAULT '[]', updated_at)`, where `mode` is `everyone` or `chosen` and `known_json` holds the module's tool names at the last save (for the drawer's "new" marker);
  - `module_access_users(owner, user_id, PRIMARY KEY (owner, user_id))`.
  - A save of a disabled or failed module, which lists no tools, keeps the `known_json` from before.
- **The rule:** the chosen users are one list per module.
  - With `mode = chosen`, only they get the module at all.
  - With `mode = everyone`, everyone gets the module, but only they get the restricted tools.
- No row means `everyone`, with no restricted tools.

```
  HomeAssistant:  mode everyone, chosen [owner, Raymond], restricted [*restart*, *delete*, *save_config*]
     member  --> list_entities, get_state, call_service ...     (no restart/delete/save)
     chosen  --> everything
  sonos:          mode chosen, chosen [owner]
     member  --> nothing from sonos (no tools, page, prompt text)
```

**P2. The owner is always allowed.** The household owner counts as chosen for every module, whether listed or not. Without this, voice devices (D3) could be locked out, and an admin could lock out the owner. Other admins are not allowed implicitly: an admin who sets the rule adds themselves when they want the access.

**P3. Restricted tools are patterns on the registered tool name.**
- Patterns use `*` as a wildcard, with the same matcher as agent tool patterns (`patternRegExp`).
- They match the name Friday registers, for example `HomeAssistant__restart_ha` or `HomeAssistant__*delete*`. The same patterns then work for any kind of module.
- **In the drawer:** each tool has a checkbox that adds its exact name. A free pattern field takes wildcards, so new tools with similar names are caught too (see Risks).

**P4. Enforcement in the registry, through one callback.**
- **Registry:** `ToolRegistry.setAccessCheck((ownerTag, toolName, user) => boolean)` is applied in `declarations` and `callTool`, after the channel and `ownerOnly` checks.
  - A refused call answers `{ error: "<name> isn't available to you" }`.
  - A call without a user (internal) counts as the owner's, as with `ownerOnly`.
- **Core:** it owns the callback, backed by an in-memory copy of the table, refreshed on every write. Core's `patternRegExp` does the matching.
- **The remote runner** sets the check to always allow, as it does `setOwnerCheck`. Core enforces it for remote tools, which are registered under `remote:<id>`.

**P5. Prompt context, routes and listing follow the module-level rule.**
- **Prompt context:** `PromptContext.render` skips the providers of an owner tag the user can't use. It checks the module-level rule only: restricted tools have no prompt text of their own.
- **Routes:** `moduleRoute` answers 403 `{ code: "no_access" }` to a user without access to the module.
- **Listing:** `moduleListing` adds `available: boolean` for the caller.
  - Members see only the modules available to them.
  - Admins see every module, with `available` and the access record, for the Modules page.
- **Row updates:** `POST /api/modules/:id/reload`, `PUT /api/modules/:id/enabled` and the access API answer with the module's entry as the caller's listing shows it, with `available` and `access`. The portal replaces the row with that answer, so the row keeps its access.
- **Portal:** `hasPage` also requires `available`, so the menu and the `/m/:id` gate hide the module. Members aren't sent the modules they may not use, so the gate treats a module whose UI the portal ships, but which isn't listed, as one the user has no access to.
- **`/api/tools`** is already per user through `declarations`.

**P6. Core and the builtin module can't be restricted.** The access API refuses `core` and `builtin`. They hold the timers, alarms, `run_agent`, `get_current_time` and `end_conversation` that voice sessions and agents depend on. Their Modules page rows show no access control.

**P7. Set in the Modules page drawer.**
- The drawer already lists a module's tools. It gets:
  - the mode (everyone or chosen users);
  - the chosen users, picked from `GET /api/users`;
  - the restricted tools (P3).
- It works the same for in-process, MCP and remote rows, and saves through `PUT /api/modules/:owner/access` (admin only).
- **Not in the MCP servers tab:** access is a Modules page setting for every kind of module, so the tab doesn't get a second copy.

**P8. Lifecycle.**
- The access record survives a module being turned off, reloaded or reconnected, because it is keyed by the owner tag.
- Deleting an MCP server deletes its record.
- A remote module that never connects again keeps its record. That is harmless, and the Modules page doesn't list it.
- A disabled user keeps their place in the chosen lists, so enabling them again restores it.

**P9. When changes take effect.**
- **Chat:** the next turn.
- **Routes and prompt context:** the next request.
- **Talk and voice sessions:** the next session, because declarations are snapshotted at open. Calls in an open session are still checked by `callTool`, so a session that started before the change gets a refusal, not the tool.
- **Agents:** the next run. Patterns that now match no tool are reported as unmatched, as today, and a parked action is re-checked when it is approved.

## Risks / Trade-offs

- **Restricted lists fail open.** A Home Assistant update can add or rename tools, and a new tool doesn't match any exact name, so members get it. → Wildcard patterns (`*delete*`, `*restart*`, `*save_*`) catch new tools with similar names. The drawer also marks tools that appeared since the record was last saved, so an admin notices them. An allowlist alternative ("members get only these tools") fails closed, at the cost of maintaining a list of everything members may use. It can be added as a second mode later.
- **Every tool call does a pattern check.** → The in-memory copy holds compiled patterns per owner tag. There are at most a few hundred tools.
- **Locking yourself out.** → The owner is always allowed (P2), and the Modules page is admin-only regardless of module access.
- **Agents silently losing tools.** An agent whose creator loses access gets fewer tools. → Unmatched patterns already show on the agent's page.

## Migration Plan

- **One additive core migration** adds the two tables. No row means today's behaviour, so the deploy changes nothing until an admin sets access. It isn't risky in the sense of `CLAUDE.md` and needs no backup.
- **Rollback:** the previous image ignores the tables, and every module is open again.
