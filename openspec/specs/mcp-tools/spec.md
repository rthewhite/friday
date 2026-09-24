# MCP Tools

## Purpose

Tools from external Model Context Protocol servers are registered in the shared tool registry so Gemini sees them identically to native tools. Servers are configured in a git-ignored `mcp.json`.

## Requirements

### Requirement: Configuration file

The loader SHALL read `mcp.json` from the working directory, or the path in `FRIDAY_MCP_CONFIG`. The file SHALL have a `servers` object keyed by server name. Each server SHALL specify either a stdio transport (`command`, optional `args`, optional `env`) or a streamable HTTP transport (`url`, optional `headers`), plus optional `include`, `exclude`, `scheduling` and `prefix`.

#### Scenario: No config file
- **WHEN** the config file does not exist
- **THEN** no MCP tools are registered and startup continues silently

#### Scenario: Invalid config file
- **WHEN** the config file exists but is not valid JSON
- **THEN** startup fails with `invalid <path>: <error>`

#### Scenario: Server without transport
- **WHEN** a server entry has neither `command` nor `url`
- **THEN** that server fails to load with an error explaining a transport is required

### Requirement: Servers are connected concurrently and failures are isolated

All servers SHALL be connected in parallel. A server that fails to connect or list tools SHALL be logged with its name and SHALL NOT prevent other servers or the application from starting.

#### Scenario: One server down
- **WHEN** one of several configured servers is unreachable
- **THEN** its error is logged and the other servers' tools are registered normally

#### Scenario: Stdio server
- **WHEN** a server defines `command`
- **THEN** it is spawned with `args` and the process environment merged with `env`

#### Scenario: HTTP server
- **WHEN** a server defines `url`
- **THEN** a streamable HTTP connection is made with the given `headers`

### Requirement: Tool naming

Each MCP tool SHALL be registered as `<prefix>__<tool>`, where `prefix` defaults to the server key. Both parts SHALL be sanitized to Gemini's allowed characters (letters, digits, `_`, `.`, `:`, `-`; leading character must be a letter or `_`), and the full name kept within Gemini's function name length limit.

#### Scenario: Default prefix
- **WHEN** server `home` exposes tool `turn_on`
- **THEN** it is registered as `home__turn_on`

#### Scenario: Custom prefix
- **WHEN** a server sets `prefix: "ha"`
- **THEN** its tools are registered as `ha__<tool>`

#### Scenario: Invalid characters
- **WHEN** a tool name contains characters outside the allowed set
- **THEN** they are replaced with `_`

### Requirement: Include and exclude filters

When `include` is set, only listed tools SHALL be registered. Tools in `exclude` SHALL be skipped.

#### Scenario: Include list
- **WHEN** `include: ["list_directory"]` is set
- **THEN** only `list_directory` is registered from that server

#### Scenario: Exclude list
- **WHEN** `exclude: ["delete_file"]` is set
- **THEN** `delete_file` is not registered

### Requirement: MCP tools use the server's input schema and scheduling

Each registered tool SHALL use the MCP tool's `inputSchema` as `parametersJsonSchema`, the MCP description (falling back to the tool name), and the server-level `scheduling` as its default.

#### Scenario: Silent server
- **WHEN** a server sets `scheduling: "SILENT"`
- **THEN** results from all its tools default to `SILENT` scheduling

### Requirement: Call results are flattened for Gemini

An MCP call result SHALL be converted as follows: if `structuredContent` is an object it is returned as-is; otherwise text content parts are joined with newlines and returned under `result` (parsed as JSON when possible), non-text parts are summarized under `attachments`, and if `isError` is set an `error` key holds the error text.

#### Scenario: Structured content
- **WHEN** the server returns `structuredContent`
- **THEN** that object is the tool result

#### Scenario: JSON text
- **WHEN** the server returns a single text part containing valid JSON
- **THEN** `result` holds the parsed JSON value

#### Scenario: Plain text
- **WHEN** the server returns text that is not JSON
- **THEN** `result` holds the raw string

#### Scenario: Error result
- **WHEN** the server sets `isError: true`
- **THEN** the result includes `error`

### Requirement: Clients are closed on shutdown

`closeMcp()` SHALL close every connected client and tolerate individual close failures.

#### Scenario: Shutdown
- **WHEN** the server shuts down
- **THEN** all MCP clients are closed
