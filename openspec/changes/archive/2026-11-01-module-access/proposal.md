# Proposal

## Why

Since `user-privacy`, the household has member accounts, but every user still gets every module's tools. A member can ask Friday in chat to restart Home Assistant, delete its automations or rewrite its configuration, because the Home Assistant MCP server's tools are offered to everyone. The only per-user rule that exists is the hard-coded owner-only flag on calendar and Spotify. Admins need to decide, per module, who may use it.

## What Changes

- **Access per module.** An admin can set, for each module, whether everyone may use it or only chosen users. "Module" means anything that owns tools: an in-process module (`spotify`, `sonos`, …), an MCP server (`mcp:<server>`) and a remote module (`remote:<id>`). A module without a setting is open to everyone, as today.
- **Restricted tools.** Within a module that everyone may use, an admin can mark tools, by name or `*` pattern, as only for the chosen users. Members can then use Home Assistant (states, lights, scenes) without getting `restart_ha`, `delete_*` or the config-editing tools. The household owner is always among the chosen users.
- **One rule, every surface.** A user without access to a module doesn't get it anywhere:
  - its tools are left out of that user's chat turns, Talk sessions and agent runs, and refused if called anyway;
  - its prompt context isn't rendered for them;
  - its portal page is left out of their menu, and its routes answer 403;
  - `/api/modules` and `/api/tools` describe only what they may use.
- **Who the user is** follows `user-privacy`. Chat and Talk use the logged-in user, agent runs use the agent's creator, and voice devices act as the owner, so they get the owner's access.
- **Set on the Modules page** by admins, in the module's drawer next to its tool list. Turning a module off still unloads it for everyone. Access only filters and never unloads.
- **Core and the builtin module stay open to everyone.** That covers timers, alarms, `run_agent`, `get_current_time` and `end_conversation`.
- **Owner-only stays** as a stricter, fixed rule for modules that hold the owner's own account, such as Spotify. An access setting can't widen it.

Out of scope:
- Per-user calendars (`per-user-calendars`), which give calendar its own per-calendar visibility.
- Per-user OAuth connections and per-user Spotify.
- Voice per person (`voice-identity`).
- Groups of users managed in Friday.

## Capabilities

### New Capabilities

- `module-access`: the per-module access setting (everyone or chosen users) and its restricted tools. It also covers the default, where the setting is stored, who may change it, how it applies to the owner and to disabled users, and the API that sets it.

### Modified Capabilities

- `tool-registry`: declarations and calls are filtered by the caller's access to the tool's owner, alongside the channel and owner-only checks.
- `module-system`: module routes and prompt context honour access, and the test host can fake it.
- `http-server`: the module listing and tool declarations are per user, and a module route answers 403 to a user without access.
- `portal-shell`: the Modules page sets access, and the menu follows the per-user module listing.

## Impact

- **SDK:**
  - `ToolRegistry` gets an access check per owner tag, used by `declarations` and `callTool` next to `setOwnerCheck`.
  - `PromptContext.render` skips the providers of an owner tag the user can't use.
  - The test host gets an option to fake access.
- **Core:**
  - A migration for the access table, keyed by owner tag.
  - A store for it, and an admin-only endpoint to set it.
  - `moduleRoute` and `moduleListing` in `app.ts`, and `/api/tools`.
  - Wiring in `server.ts`.
- **Portal:**
  - `ModulesPage.vue`: the access controls in the drawer, with a user picker based on `GET /api/users`.
  - `hasPage` in `lib/modules.ts` also requires the listing's new `available` flag, so the menu and the module gate follow it.
- **Overlap:** `per-user-calendars` also changes the calendar's owner checks. This change leaves calendar alone; that change takes calendar off owner-only.
