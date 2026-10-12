# Spec Delta

## MODIFIED Requirements

### Requirement: Module listing endpoint

`GET /api/modules` SHALL return a JSON array with one entry per module in core's list: `id`, `label`, `description`, `status` (`loaded`, `failed` or `disabled`), `error` when failed, and `tools` (names). Every stored MCP server SHALL appear with `id` `mcp:<server>` and a `status` of `loaded` when connected, `failed` with `error` when its connection failed, or `disabled` when it is disabled. Failed and disabled servers SHALL have an empty `tools` array. When core itself owns registered tools (tool owner `core`), the array SHALL start with an entry for core: `id` `core`, `label` `Core`, a `description` saying it is built into Friday, `status` `loaded`, `tools` with the names of the tools core owns, and `ui` false. Without tools owned by core there SHALL be no such entry.

#### Scenario: All modules loaded
- **WHEN** a client requests `/api/modules`
- **THEN** it receives `builtin` and `media` with status `loaded` and their tool names

#### Scenario: Disabled module
- **WHEN** `FRIDAY_MODULES=builtin`
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
