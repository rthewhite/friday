## MODIFIED Requirements

### Requirement: Module listing endpoint

`GET /api/modules` SHALL return a JSON array with one entry per module in core's list: `id`, `label`, `description`, `status` (`loaded`, `failed` or `disabled`), `error` when failed, and `tools` (names). An in-process module SHALL report `disabled` exactly when its stored enablement is off. Every stored MCP server SHALL appear with `id` `mcp:<server>` and a `status` of `loaded` when connected, `failed` with `error` when its connection failed, or `disabled` when it is disabled. Failed and disabled servers SHALL have an empty `tools` array. When core itself owns registered tools (tool owner `core`), the array SHALL start with an entry for core: `id` `core`, `label` `Core`, a `description` saying it is built into Friday, `status` `loaded`, `tools` with the names of the tools core owns, and `ui` false. Without tools owned by core there SHALL be no such entry.

The listing SHALL be built for the requesting user, following their module access (as specified in `module-access`):
- **`available`:** every entry SHALL carry `available`, which is false when the user may not use the module (`mode: chosen` without them).
- **Members:** a member SHALL NOT be sent the entries that aren't available to them. In the entries they do get, `tools` SHALL hold only the tools they may use.
- **Admins:** an admin SHALL be sent every entry with every tool. Each entry that can have an access setting (everything except `core` and `builtin`) SHALL also carry `access`, holding:
  - `mode`;
  - `users`, as `{ id, name }`;
  - `restricted`;
  - `knownTools`: the tool names the module had when its access was last saved. It is absent while the setting is the default.

#### Scenario: All modules loaded
- **WHEN** a client requests `/api/modules`
- **THEN** it receives `builtin` and `media` with status `loaded`, `available: true` and their tool names

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

#### Scenario: Member without access
- **WHEN** member `Sanne` requests `/api/modules` and `sonos` is `mode: chosen` without her
- **THEN** there is no `sonos` entry in her listing

#### Scenario: Member with restricted tools
- **WHEN** member `Sanne` requests `/api/modules` and `HomeAssistant__restart_ha` is restricted
- **THEN** the `mcp:HomeAssistant` entry is listed without `HomeAssistant__restart_ha` in its `tools`, and has no `access`

#### Scenario: Admin sees access
- **WHEN** an admin requests `/api/modules` and `sonos` is `mode: chosen` with only `Sanne`
- **THEN** the `sonos` entry has `available: false` for that admin, all its tools, and `access` with `mode: "chosen"` and `users: [{ id, name: "Sanne" }]`

### Requirement: Module routes are mounted

Requests under `/api/modules/<id>/` SHALL be dispatched to the module's registered routes; an unknown module or path responds 404. A request from a user who may not use the module (as specified in `module-access`) SHALL respond 403 with `{ error, code: "no_access" }` without reaching the module's handler.

#### Scenario: Dispatch
- **WHEN** media registered `GET search`
- **THEN** `/api/modules/media/search` reaches media's handler and `/api/modules/nope/search` responds 404

#### Scenario: No access
- **WHEN** member `Sanne` requests `GET /api/modules/sonos/speakers` while `sonos` is `mode: chosen` without her
- **THEN** the response is 403 with `code: "no_access"` and the handler isn't called
