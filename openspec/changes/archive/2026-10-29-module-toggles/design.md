# Design

## Context

`ModuleHost` already has a `disabled` status. `load()` gives it to every module that the `enabled` option leaves out. That option is `FRIDAY_MODULES`, passed in by `server.ts`. A disabled entry is never initialized, `reload()` refuses it, `routesOf()` hides it, and `oauth/requests.ts` already leaves disabled manifests out. `teardown()` (used by reload) already removes tools, routes, jobs, prompt providers and `onQuiet` subscriptions, then calls `dispose()`. What's missing is a stored choice and a way to move between `disabled` and the other states while Friday runs.

MCP servers are the precedent: an `enabled` flag in `friday.db`, toggled from Settings, applied at runtime.

Tools only exist after `init`: a manifest doesn't list them. So nothing can know which tools a module that has been disabled since startup would provide.

## Goals / Non-Goals

**Goals:**
- One stored on/off per in-process module, read at startup and changed at runtime through one host path.
- Disable and enable reuse the existing teardown and init paths, so they behave exactly like a reload and a startup.

**Non-Goals:**
- Per-user or per-role module access. This is per instance only.
- Toggling `core`, remote modules or MCP servers. MCP servers keep their own flag.
- Purging a module's data on disable.
- Module dependencies (`sonos` works best with `spotify`). Not modelled.
- Warning on agents about disabled modules. The agents page already marks patterns that match nothing, and a disabled module's tool names are unknown (see Context).

## Decisions

### A core table, one row per explicit choice

Migration `module_enablement (module_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL, updated_at TEXT NOT NULL)` in `storage/db.ts`, with the next free core version at merge time (10 is the latest on `main`, and `auth-users` will claim one too). A small store next to it offers `isEnabled(id)` (no row means true) and `set(id, enabled)`.

*Alternatives:* `config_values` under scope `core`. Rejected: those are configuration keys with scope resolution and the env fallback, edited on the Configuration page, and enablement must not resolve from env. `module_kv` is per module, so a module would hold its own switch. Storing only disabled ids works too, but a row for every explicit choice costs nothing and records when it was made.

### The host owns the lifecycle, the store is injected

`ModuleHostOptions.enabled` (the comma-separated string) is replaced by `enablement?: { isEnabled(id): boolean; set(id, enabled): void }`. Without it, every module is enabled. `server.ts` passes the db-backed store. Tests pass an in-memory one or none, so no test needs an env var. New `setEnabled(id, enabled)` on the host:

```
setEnabled(id, on):
  entry unknown            -> undefined (route answers 404)
  serialized per module:
    enablement.set(id, on)                         stored before acting
    on  && status disabled -> init(entry)          loaded | failed
    !on && status loaded   -> teardown(entry); status = disabled
    !on && status failed   -> status = disabled    (failed init already cleaned up)
    otherwise              -> no-op
  -> the module's listing entry
```

`load()` asks `isEnabled(id)` instead of parsing the list. The unknown-id warning goes away, because stored rows for removed modules are simply ignored.

### Per-module serialization

`reload` and `setEnabled` run through a per-module promise chain (`Map<id, Promise>`), so a disable that arrives during a reload waits for it. Today two concurrent reloads of one module can interleave. This fixes that too, at no extra cost.

### Endpoint: `PUT /api/modules/:id/enabled`

An idempotent PUT of a boolean fits a stored flag better than `POST .../enable` and `.../disable`, and it matches how MCP servers carry `enabled`. It answers with the listing entry, so the portal updates the row and the sidebar from one response. It sits next to `POST /api/modules/:id/reload` in `app.ts`. Reload answers 409 for a disabled module (the host returns a distinguishable result rather than `undefined`), and 404 stays for unknown ids.

### Configuration listing: disabled requesters are kept and marked

The listing keeps aggregating over every requester (core and every module), and marks a disabled module's item in `modules` with `disabled: true`:
- A key that only disabled modules declare is dropped unless some scope stores it, so the keys of a module that doesn't apply here disappear, while a stored value stays visible and clearable.
- `required` counts only requesters that aren't disabled. The entry's scope is resolved over its requesters, active ones first, so it is the module's own copy (or global), never a stray copy in another module's scope.
- Secrecy still comes from every requester, so a key a disabled module declares secret is never shown, not even from the environment.
- The portal marks those requesters as off. It doesn't let them make the default scope `global`. `Save and reload` skips them (`reloadTargets` in `lib/config-scope.ts`, `defaultScope` there too).

*Alternative tried first:* listing only active requesters, and showing a disabled module's stored keys as undeclared (empty `modules`). The code review found that this made the Configuration page treat them as global keys. The default scope became `global`, so a save created a global value every module reads, and the module's own copy was labelled "probably left over". It also dropped the secret flag of a key that only a disabled module declares secret, when an active module declares it plain and the value comes from the environment.

`PUT /api/config/:scope/...` keeps accepting any module in the list as a scope (it already checks `manifests()`, any status).

### Portal

- Move `pages/ModulesPage.vue` to `pages/settings/ModulesPage.vue`, route `/settings/modules`, and redirect `{ path: "/modules", redirect: "/settings/modules" }`.
- `Shell.vue`: the `Modules` nav item moves to group `System` (first). The `Modules` group renders only when it has module-UI items.
- The switch uses the portal-ui components already there (a toggle or a `Button` pair, whichever `McpServersTab.vue` uses for its enabled flag, for consistency), with a confirm on disable. After the call, update the shared `useModules()` state so the sidebar and `ModuleGate` follow without a refetch.
- `ModuleGate.vue`: for `disabled`, "turned off for this Friday" with a link to `/settings/modules`. No `FRIDAY_MODULES`.

### Admin role

`auth-users` (in flight) makes the System section and module reload admin-only. If it's on `main` when this change is applied, `PUT /api/modules/:id/enabled` joins its admin-only API list, and `/settings/modules` is gated with the rest of System. A `user-auth` delta records that, written during the rebase. `GET /api/modules` stays readable for members, because the sidebar and `ModuleGate` need it. If this change lands first, the endpoint is as open as reload is today (the cross-origin rule applies), and `auth-users` picks it up when it rebases.

## Risks / Trade-offs

- [A fresh work instance starts with every module enabled, so several show `failed` until the admin turns them off] → One-time, visible on the Modules page. The alternative ("off until enabled") would leave a fresh home install empty.
- [A module disabled from day one has never migrated. Enabling it later runs its migrations at runtime] → This is the same code path as startup, and `module-database` already isolates a failing migration to that module.
- [`FRIDAY_MODULES` left set somewhere is now silently ignored] → Log one warning at startup when it is set: it is no longer used, use Settings > Modules.
- [A `dispose()` that hangs makes the disable request hang] → Same as reload today. Not addressed here.
- [An open voice session keeps the tool list it was offered and may call a removed tool] → The registry answers `unknown tool <name>`, as after a reload. The next session is correct.
- [Migration number clash with `auth-users`] → The number is claimed at merge. Renumber during the rebase if needed.

## Migration Plan

1. Deploy. Home sets no `FRIDAY_MODULES` (`deploy/k8s.yaml`), so with no rows stored every module stays enabled and nothing changes.
2. On the work instance, turn off the modules that don't apply on System > Modules.

Rollback: an older image ignores `module_enablement` and loads every module, because `FRIDAY_MODULES` is unset. The migration runner skips versions it doesn't know, so the newer schema version doesn't stop it.
