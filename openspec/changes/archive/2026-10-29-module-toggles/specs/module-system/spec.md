# Spec Delta

## ADDED Requirements

### Requirement: In-process modules are loaded from a fixed list, filtered by stored enablement

Core SHALL hold an explicit list of in-process modules. Whether a module is enabled SHALL be stored in `friday.db` per module id. A module without a stored choice SHALL be enabled. On startup, core SHALL initialize the enabled modules in list order. A disabled module SHALL NOT be initialized and SHALL NOT run its migrations, and it SHALL report status `disabled`. Stored choices for ids that are no longer in the list SHALL be ignored and kept. The environment SHALL NOT influence which modules load.

#### Scenario: Fresh database
- **WHEN** Friday starts with an empty `friday.db`
- **THEN** every module in the list is initialized in order

#### Scenario: Module switched off earlier
- **WHEN** `sonos` was disabled and Friday restarts
- **THEN** `sonos` reports `disabled`, its tools are absent from `/api/tools`, and every other module loads

#### Scenario: Module added in a later release
- **WHEN** a release adds module `documents` to the list and the database holds choices only for older modules
- **THEN** `documents` is initialized like any enabled module

#### Scenario: Environment is ignored
- **WHEN** `FRIDAY_MODULES=builtin` is set in the environment and nothing is stored
- **THEN** every module in the list is initialized

### Requirement: Modules can be enabled and disabled at runtime

The host SHALL let an in-process module be enabled or disabled while Friday runs, and SHALL store the choice before acting on it, so it survives a restart.
- Disabling a `loaded` module SHALL tear it down as a reload does: its tools, routes, prompt context providers and conversation subscriptions are removed, its jobs are removed with any in-progress run cancelled, and `dispose()` runs. Disabling a `failed` module SHALL only change its status. The module then reports `disabled`.
- Enabling a `disabled` module SHALL initialize it as startup does: validate the manifest and required configuration, run pending migrations, and call `init`. It then reports `loaded`, or `failed` with the error. The stored choice SHALL stay enabled when it fails.
- Enabling an enabled module, or disabling a disabled one, SHALL change nothing.
- A disabled module's tables, `module_kv` entries, stored configuration, OAuth grants and job history SHALL be kept. A module enabled again SHALL resume with them.
- Enabling, disabling and reloading the same module SHALL run one after another, never interleaved.

`core`, remote modules and MCP servers SHALL NOT be enabled or disabled through this mechanism.

#### Scenario: Disable a loaded module
- **WHEN** the admin disables `sonos` while it is `loaded`
- **THEN** its tools leave the registry, `/api/modules/sonos/...` responds 404, its `dispose` runs, and it reports `disabled`

#### Scenario: Disable during a job run
- **WHEN** `brain` is disabled while its nightly job is running
- **THEN** the run is cancelled, its jobs are removed, and its job history is kept

#### Scenario: Enable without configuration
- **WHEN** the admin enables `media` and `JELLYFIN_URL` is not set
- **THEN** `media` reports `failed` with an error naming `JELLYFIN_URL`, and after a restart it is still enabled and fails the same way

#### Scenario: Enable runs pending migrations
- **WHEN** a module that was disabled from the first start, so none of its migrations ran, is enabled
- **THEN** its migrations run before `init` and it reports `loaded`

#### Scenario: Data survives a disable
- **WHEN** `brain` is disabled and enabled again
- **THEN** its pages, revisions and stored settings are unchanged

#### Scenario: Voice session open during a disable
- **WHEN** `sonos` is disabled while a voice session that was offered `sonos_play` is open, and the model calls `sonos_play`
- **THEN** the call returns an `unknown tool sonos_play` error, and the next session is not offered `sonos_play`

#### Scenario: Disable while reloading
- **WHEN** a disable of `media` arrives while `media` is being reloaded
- **THEN** the reload finishes first, then `media` is torn down and reports `disabled`

## REMOVED Requirements

### Requirement: In-process modules are loaded from a fixed list, filtered by FRIDAY_MODULES

**Reason**: Which modules run is now chosen per instance by an admin in the portal and stored in `friday.db`, with no env var.
**Migration**: Remove `FRIDAY_MODULES` from the environment, then disable the modules it left out on the Modules page (System > Modules). Until then they load, and fail when their configuration is missing.
