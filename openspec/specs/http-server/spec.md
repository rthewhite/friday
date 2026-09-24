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

On startup the server SHALL load all tools (builtin, media, MCP) before accepting connections, log the registered tool names, and warn if `GEMINI_API_KEY` is unset.

#### Scenario: Startup
- **WHEN** the server starts
- **THEN** all tools are loaded before the HTTP server listens

#### Scenario: Missing API key
- **WHEN** `GEMINI_API_KEY` is empty
- **THEN** a warning is logged and the server still starts

### Requirement: Graceful shutdown closes MCP clients

On SIGINT or SIGTERM the server SHALL close all MCP clients before exiting.

#### Scenario: Shutdown signal
- **WHEN** the process receives SIGINT or SIGTERM
- **THEN** MCP clients are closed before the process exits

