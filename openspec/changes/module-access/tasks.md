# Tasks

## 1. SDK: the access check in the registry, prompt context and test host

- [ ] 1.1 Add `ToolRegistry.setAccessCheck((ownerTag, toolName, user) => boolean)`. `declarations(channel, user?)` leaves out refused tools, and `callTool` refuses them with `{ error: "<name> isn't available to you" }` (scheduling `INTERRUPT`) without calling the handler. The check runs after the channel and owner-only checks, and a registry without a check allows everything. Verify with `registry.test.ts` cases: a restricted tool left out, a forced call refused, a tool not in the channel still unknown, an owner-only tool keeping its owner-only error, and no check offering every tool.
- [ ] 1.2 The remote runner sets the access check to always allow, as it does `setOwnerCheck`. Verify with a `remote-runner.test.ts` case.
- [ ] 1.3 `PromptContext.render(channel, user?)` takes a module-level check `(ownerTag, user) => boolean` and skips the providers of a refused owner tag. A render without a user counts as the owner's. Verify with a `prompt` test: a refused owner's text is missing and the others' is present.
- [ ] 1.4 Test host: the `access` option `(user, toolName?) => boolean`, applied per tool to declarations and calls and per module to prompt rendering. Without it everything is allowed. Verify with `test-host.test.ts` cases for the "Module test with access" scenario and the no-option default.
- [ ] 1.5 Document `setAccessCheck` and the test host's `access` option in `packages/sdk/README.md`, then run `pnpm --filter @friday/sdk test typecheck build`. Verify all three are green.

## 2. Core: the access store and the rule

- [ ] 2.1 Add core migration 14 (renumber at merge if taken) with `module_access` (`owner`, `mode`, `restricted_json`, `known_json`, `updated_at`) and `module_access_users` (`owner`, `user_id`, primary key on both). Verify with a `storage.test.ts` migration case: the tables exist and existing data is untouched.
- [ ] 2.2 Add `ModuleAccessStore`: `get(owner)`, `set(owner, { mode, users, restricted, known })`, `clear(owner)`, and an in-memory copy with compiled `patternRegExp` patterns, refreshed on every write. It answers `allowsModule(owner, user)` and `allowsTool(owner, tool, user)`:
  - the owner, or a call without a user, is always allowed;
  - otherwise only chosen users are allowed;
  - `chosen` refuses the whole module to everyone else;
  - `everyone` refuses only the tools matching a `restricted` pattern;
  - no row allows everything;
  - `core` and `builtin` are always allowed.

  Verify with `module-access.test.ts` cases for every "Who may use a module" scenario, including the owner always allowed, another admin not implied, and a disabled user keeping their place.
- [ ] 2.3 Map listing ids to owner tags: an in-process id and `mcp:<server>` stay as they are, and a remote `<id>` becomes `remote:<id>`. Use the mapping everywhere a listing id is used. Verify with a unit test for the three kinds.
- [ ] 2.4 Wire the store in `server.ts`: `registry.setAccessCheck` and the prompt context's module check. Deleting an MCP server clears `mcp:<server>`'s setting. Verify with tests: a member's chat turn and Talk session leave out a `chosen` module's tools; a voice session, which acts for the owner, gets them; an agent run of a member's agent leaves out a restricted tool; and a deleted and re-created MCP server starts at the default.
- [ ] 2.5 Run `pnpm --filter @friday/core test typecheck`. Verify both are green.

## 3. Core: the API, listing and routes

- [ ] 3.1 `PUT /api/modules/:id/access` and `DELETE /api/modules/:id/access` are admin only. They answer:
  - 403 for a member;
  - 400 with a message for a bad `mode`, an unknown user id, or an empty or non-string pattern, leaving the setting unchanged;
  - 404 for `core`, `builtin` or an id not in the listing;
  - otherwise 200 with the module's new listing entry.

  `PUT` stores the module's current tool names as `known`. Verify with `module-access-api.test.ts` cases for every "Module access API" scenario.
- [ ] 3.2 `moduleListing` is built for the requesting user:
  - every entry carries `available`;
  - members don't get unavailable entries, and get only their own tools in `tools`;
  - admins get every entry and tool, plus `access { mode, users: { id, name }, restricted, knownTools }` on everything except `core` and `builtin`.

  Verify with `platform-api.test.ts` cases for the "Member without access", "Member with restricted tools" and "Admin sees access" scenarios, plus the existing listing cases passing with `available: true`.
- [ ] 3.3 `moduleRoute` answers 403 `{ error, code: "no_access" }` to a user without access to the module, without calling the handler. Verify with the "No access" route scenario test.
- [ ] 3.4 Changes apply without a restart:
  - the next chat turn and `/api/tools` follow a new setting;
  - an open session's call to a newly restricted tool is refused;
  - a parked agent action whose tool became restricted fails on approval;
  - a remote module that reconnects keeps its setting.

  Verify with tests for the "Open session" and "Reconnect keeps access" scenarios and the approval re-check.
- [ ] 3.5 Run `pnpm --filter @friday/core test typecheck`. Verify both are green.

## 4. Portal: menu and Modules page

- [ ] 4.1 Add `available` and `access` to the portal's `ApiModule` type. `hasPage` also requires `available`, and `/m/:id` for a module that isn't available to the user shows "isn't available to you, ask an admin" without saying who may use it. Verify with `lib/modules` and `nav` unit tests for the "Member navigation" and "Module not available to the user" scenarios.
- [ ] 4.2 Modules page rows show `Chosen users` or `Some tools restricted` when access isn't the default. Verify with a unit test of the label helper.
- [ ] 4.3 Add an Access section to the drawer of every entry with `access` (none for `core` and `builtin`):
  - Everyone or Chosen users;
  - the users from `GET /api/users`, with the owner always ticked and locked, and disabled users marked;
  - only for Everyone: a checkbox per tool plus a pattern field, with tools matched by a pattern shown as restricted;
  - tools not in `knownTools` marked new;
  - `Save` (PUT) and `Reset to everyone` (DELETE), both updating the row. A failed request keeps the edits and shows the error.

  Verify with unit tests of the pure helpers (pattern matching, the "new" marker, building the PUT body), and with `pnpm --filter @friday/portal test typecheck build`.
- [ ] 4.4 Check by hand on a dev server on free ports (`FRIDAY_PORT=8081 FRIDAY_CORE_URL=http://localhost:8081 pnpm dev`):
  - restrict a tool on an MCP server or module from the drawer, save, reload, and see the setting kept and the row label shown;
  - reset to everyone.

  Stop the dev server afterwards.

## 5. Docs and integration

- [ ] 5.1 Document module access in `README.md` (who may use a module, restricted tools, the owner always allowed, core and builtin always open, devices acting as the owner), and add the module-access context to `openspec/config.yaml`. Verify that the README section matches the spec's rules.
- [ ] 5.2 Run `pnpm -r build && pnpm -r typecheck && pnpm -r test`. Verify all three are green.
- [ ] 5.3 On the deployed instance, as a member account (after the user approves the push): set Home Assistant to Everyone with `restart_ha` restricted, and check that the member's chat no longer offers it while the owner's does. Then set a module with a page to Chosen users without the member, and check that its menu entry is gone for the member.
