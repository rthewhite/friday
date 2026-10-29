# Proposal

## Why

Every module in `modules.ts` is on in every deployment, unless `FRIDAY_MODULES` narrows the list at boot. A second Friday is planned at work, for colleagues, where some modules don't apply: there are no Sonos speakers, no Jellyfin and no household calendar. Today those modules would show up as `failed` (missing configuration) and ask for keys nobody should fill in. An admin should be able to switch a module off for this instance from the portal, without an env var or a redeploy, so `failed` keeps meaning "should work and doesn't".

## What Changes

- **Module enablement is stored in `friday.db`.** A new core table holds one row per module the admin has switched on or off. A module without a row is enabled, so a fresh install and a module added in a later release start enabled.
- **`FRIDAY_MODULES` is removed.** Enablement is controlled only through the database. **BREAKING** for deployments that set it. `deploy/k8s.yaml` doesn't.
- **Enable and disable at runtime.** `PUT /api/modules/:id/enabled` with `{ enabled }` turns an in-process module on or off immediately and stores the choice. Disabling tears the module down as a reload does (tools, routes, jobs, prompt context, conversation subscriptions). Enabling runs the same path as startup (config check, pending migrations, `init`). A disabled module keeps its data, stored configuration and OAuth grants. `core`, MCP servers and remote modules can't be toggled here. MCP servers keep their own `enabled` flag.
- **Reloading a disabled module is refused** with 409, instead of the 404 an unknown module gets.
- **A disabled module's configuration keys drop out of Settings > Configuration** unless an enabled module or core also declares them. Stored values are kept and still listed under `stored`, and enabling the module brings the keys back.
- **The Modules page moves to System** as `/settings/modules`, with an enable/disable switch per in-process module next to `Reload`. `/modules` redirects there. The `Modules` sidebar section keeps only the module UIs (`/m/<id>`) and is hidden when none is enabled.
- **The "module not available" page** no longer mentions `FRIDAY_MODULES`. For a disabled module it says the module is turned off and links to the Modules page.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `module-system`: the in-process module list is filtered by stored enablement instead of `FRIDAY_MODULES`. New requirement for enabling and disabling a module at runtime.
- `http-server`: `/api/modules` reports stored enablement. New `PUT /api/modules/:id/enabled` endpoint.
- `secret-management`: the configuration listing leaves out keys declared only by disabled modules, and module reload refuses a disabled module.
- `oauth-connections`: a disabled module's OAuth requests disappear, as a removed module's do.
- `platform-storage`: the "module disabled" scenario no longer refers to `FRIDAY_MODULES`.
- `portal-shell`: Modules moves into the System section with an enable/disable switch, and the Modules section holds only module UIs.
- `user-auth`: `PUT /api/modules/:id/enabled` is admin-only, like module reload. `GET /api/modules` stays open to members. Added at apply time, once `auth-users` had landed on `main`.

## Impact

- Core: `packages/core/src/storage/db.ts` (a new migration: `module_enablement`), a small store next to it, `module-host.ts` (`enable`/`disable`, `load` reading stored enablement), `server.ts` (no more `FRIDAY_MODULES`), `app.ts` (the new endpoint, reload's 409, the config listing's requesters), `oauth/requests.ts` (comment only; disabled modules are already left out).
- Portal: `router.ts` (`/settings/modules`, the `/modules` redirect), `shell/Shell.vue` (nav groups), `pages/ModulesPage.vue` (moved to `pages/settings/`, switch), `shell/ModuleGate.vue`, `composables/useModules.ts`.
- Tests: `module-host`, `reload`, `app` and `platform-api` tests that use `FRIDAY_MODULES` or the host's `enabled` option.
- Docs: README (the "leave it out with `FRIDAY_MODULES`" lines for media, sonos, travel and calendar, plus line 49), `.env.example`, `packages/sdk/README.md`, the `openspec/config.yaml` context.
- Overlap: `auth-users` (in flight) also touches `app.ts`, `Shell.vue` and the System section, and puts module reload behind the admin role. Merge `auth-users` first. This change then puts the new endpoint behind the admin role too, and the moved Modules page falls under the admin-only System section. Both changes add a core migration. The number is claimed at merge time. `document-store` adds a module to `modules.ts`, which starts enabled under this change.
