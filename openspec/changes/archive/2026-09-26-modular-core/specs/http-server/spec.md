# Spec Delta

## MODIFIED Requirements

### Requirement: Startup loads tools and warns on missing API key

On startup the server SHALL load in-process modules through the module host and attach MCP servers before accepting connections, log each loaded module with its tool names and any failed module with its error, and warn if `GEMINI_API_KEY` is unset.

#### Scenario: Startup
- **WHEN** the server starts
- **THEN** modules and MCP tools are loaded before the HTTP server listens

#### Scenario: Missing API key
- **WHEN** `GEMINI_API_KEY` is empty
- **THEN** a warning is logged and the server still starts

#### Scenario: Failed module
- **WHEN** a module fails to initialize
- **THEN** the failure is logged with its id and the server still starts

### Requirement: Graceful shutdown closes MCP clients

On SIGINT or SIGTERM the server SHALL dispose loaded modules and close all MCP clients before exiting.

#### Scenario: Shutdown signal
- **WHEN** the process receives SIGINT or SIGTERM
- **THEN** modules are disposed and MCP clients are closed before the process exits

## ADDED Requirements

### Requirement: Module listing endpoint

`GET /api/modules` SHALL return a JSON array with one entry per module in core's list: `id`, `label`, `description`, `status` (`loaded`, `failed` or `disabled`), `error` when failed, and `tools` (names). MCP servers SHALL appear with `id` `mcp:<server>` and `status` `loaded`.

#### Scenario: All modules loaded
- **WHEN** a client requests `/api/modules`
- **THEN** it receives `builtin` and `media` with status `loaded` and their tool names

#### Scenario: Disabled module
- **WHEN** `FRIDAY_MODULES=builtin`
- **THEN** `media` appears with status `disabled` and an empty `tools` array
