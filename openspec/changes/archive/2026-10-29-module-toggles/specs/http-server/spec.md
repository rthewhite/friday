# Spec Delta

## MODIFIED Requirements

### Requirement: Module listing endpoint

`GET /api/modules` SHALL return a JSON array with one entry per module in core's list: `id`, `label`, `description`, `status` (`loaded`, `failed` or `disabled`), `error` when failed, and `tools` (names). An in-process module SHALL report `disabled` exactly when its stored enablement is off. Every stored MCP server SHALL appear with `id` `mcp:<server>` and a `status` of `loaded` when connected, `failed` with `error` when its connection failed, or `disabled` when it is disabled. Failed and disabled servers SHALL have an empty `tools` array. When core itself owns registered tools (tool owner `core`), the array SHALL start with an entry for core: `id` `core`, `label` `Core`, a `description` saying it is built into Friday, `status` `loaded`, `tools` with the names of the tools core owns, and `ui` false. Without tools owned by core there SHALL be no such entry.

#### Scenario: All modules loaded
- **WHEN** a client requests `/api/modules`
- **THEN** it receives `builtin` and `media` with status `loaded` and their tool names

#### Scenario: Disabled module
- **WHEN** `media` has been disabled
- **THEN** `media` appears with status `disabled` and an empty `tools` array

#### Scenario: Failed MCP server
- **WHEN** stored server `home` is unreachable
- **THEN** `mcp:home` appears with status `failed`, its connection error, and an empty `tools` array

#### Scenario: Disabled MCP server
- **WHEN** stored server `home` has `enabled: false`
- **THEN** `mcp:home` appears with status `disabled` and an empty `tools` array

#### Scenario: Core's tools
- **WHEN** core has registered `set_timer`, `list_timers`, `cancel_timer` and `snooze_alert`, and a client requests `/api/modules`
- **THEN** the first entry is `core`, labelled `Core`, with status `loaded`, those four tool names, and no UI, followed by the modules

#### Scenario: Core without tools
- **WHEN** no tool is owned by core
- **THEN** `/api/modules` has no `core` entry

## ADDED Requirements

### Requirement: Module enablement endpoint

`PUT /api/modules/:id/enabled` with body `{ "enabled": true | false }` SHALL enable or disable the in-process module `:id` as specified in `module-system`, and respond 200 with the module's new entry in the shape of `/api/modules`, once the module has been initialized or torn down. A body whose `enabled` is not a boolean SHALL be refused with 400 and nothing changes. An id that is not an in-process module in core's list (including `core`, `mcp:<server>` and remote modules) SHALL respond 404.

#### Scenario: Disable
- **WHEN** a client sends `PUT /api/modules/sonos/enabled` with `{ "enabled": false }`
- **THEN** the response is 200 with `sonos` at status `disabled` and no tools, and `/api/tools` no longer lists the `sonos_*` tools

#### Scenario: Enable
- **WHEN** a client sends `{ "enabled": true }` for the disabled `travel` module and `TOMTOM_API_KEY` is set
- **THEN** the response is 200 with `travel` at status `loaded` and its tools

#### Scenario: Enable fails
- **WHEN** a client enables `media` without its required configuration
- **THEN** the response is 200 with `media` at status `failed` and the error

#### Scenario: Not a boolean
- **WHEN** the body is `{ "enabled": "no" }`
- **THEN** the response is 400 and the module is unchanged

#### Scenario: Not an in-process module
- **WHEN** a client sends the request for `core`, `mcp:home` or `nope`
- **THEN** the response is 404
