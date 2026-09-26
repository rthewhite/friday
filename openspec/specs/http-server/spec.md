# HTTP Server

## Purpose

The Node HTTP server that hosts Friday: it serves the static web client from `web/`, exposes the current tool declarations at `/api/tools`, loads tools at startup, and shuts down cleanly. It also upgrades `/ws/audio` connections, whose protocol is specified in [audio-transport](../audio-transport/spec.md).

## Requirements

### Requirement: HTTP server serves the web client and tool declarations

The server SHALL listen on `FRIDAY_HOST`:`FRIDAY_PORT` (default `0.0.0.0:8080`), serve files from the `web/` directory with `/` mapping to `index.html`, and return the current tool declarations as JSON at `/api/tools`.

#### Scenario: Root request
- **WHEN** a client requests `/`
- **THEN** `web/index.html` is served as `text/html`

#### Scenario: Static asset
- **WHEN** a client requests a path that exists under `web/`
- **THEN** the file is served with a content type appropriate to its extension

#### Scenario: Missing file
- **WHEN** a client requests a path that does not exist under `web/`
- **THEN** the server responds 404

#### Scenario: Tool declarations
- **WHEN** a client requests `/api/tools`
- **THEN** the server responds with the JSON array of Gemini function declarations

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

### Requirement: Module listing endpoint

`GET /api/modules` SHALL return a JSON array with one entry per module in core's list: `id`, `label`, `description`, `status` (`loaded`, `failed` or `disabled`), `error` when failed, and `tools` (names). MCP servers SHALL appear with `id` `mcp:<server>` and `status` `loaded`.

#### Scenario: All modules loaded
- **WHEN** a client requests `/api/modules`
- **THEN** it receives `builtin` and `media` with status `loaded` and their tool names

#### Scenario: Disabled module
- **WHEN** `FRIDAY_MODULES=builtin`
- **THEN** `media` appears with status `disabled` and an empty `tools` array

### Requirement: Remote module WebSocket upgrade

The server SHALL upgrade `/ws/modules` connections and hand them to the remote module host. Other upgrade paths remain unchanged.

#### Scenario: Upgrade
- **WHEN** a client opens a WebSocket to `/ws/modules`
- **THEN** the remote module handshake begins

### Requirement: Shutdown closes remote modules

On SIGINT or SIGTERM the server SHALL close all remote module sockets with code `1001` before exiting.

#### Scenario: Shutdown with remotes connected
- **WHEN** the process receives SIGTERM while simracing is connected
- **THEN** simracing's socket is closed with 1001 and its runner will reconnect after backoff
