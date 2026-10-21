# Spec Delta

## MODIFIED Requirements

### Requirement: Stored server definitions

MCP servers SHALL be defined in core's database and nowhere else, and SHALL be reached over streamable HTTP only; core SHALL NOT start processes for MCP servers. A server definition SHALL have a unique `name` matching `^[A-Za-z][A-Za-z0-9_-]{0,31}$`, an `enabled` flag (default `true`), a `url` (http or https), optional `headers` entries, and optional `include`, `exclude`, `scheduling` (`INTERRUPT`, `WHEN_IDLE` or `SILENT`), `prefix` and `channels` (a non-empty list of distinct values from `voice`, `chat` and `agent`; unset means all three). Each header entry SHALL be `{ name, value, secret }`. Definitions SHALL persist across restarts. Enabled servers SHALL be connected at startup. Disabled servers SHALL NOT be connected and SHALL register no tools.

#### Scenario: No servers configured
- **WHEN** the database holds no MCP server definitions
- **THEN** no MCP tools are registered and startup continues silently

#### Scenario: Definition survives restart
- **WHEN** server `home` is created and Friday restarts
- **THEN** `home` is connected again at startup with the same definition

#### Scenario: Disabled server
- **WHEN** server `home` has `enabled: false`
- **THEN** it is not connected and no `home__*` tools are registered

#### Scenario: Invalid channels
- **WHEN** a write sets `channels: []` or `channels: ["email"]`
- **THEN** the response is 400 and the definition is unchanged

### Requirement: MCP tools use the server's input schema and scheduling

Each registered tool SHALL use the MCP tool's `inputSchema` as `parametersJsonSchema`, the MCP description (falling back to the tool name), the server-level `scheduling` as its default, and the server-level `channels` when set.

#### Scenario: Silent server
- **WHEN** a server sets `scheduling: "SILENT"`
- **THEN** results from all its tools default to `SILENT` scheduling

#### Scenario: Agent-only server
- **WHEN** server `github` sets `channels: ["agent"]`
- **THEN** its tools are offered to agents only, and voice sessions and chat turns do not see them

## ADDED Requirements

### Requirement: Channels in the MCP servers tab

The portal's MCP servers tab SHALL show each server's channels and SHALL let the user choose them in the server form as `voice`, `chat` and `agent` checkboxes, all checked by default. Saving with all three checked SHALL store the server without `channels`.

#### Scenario: Make a server agent-only
- **WHEN** the user unchecks `voice` and `chat` for `github` and saves
- **THEN** `github` is stored with `channels: ["agent"]`, reconnects, and its tools leave voice and chat
