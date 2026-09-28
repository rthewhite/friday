# Spec Delta

## MODIFIED Requirements

### Requirement: Startup loads tools and warns on missing API key

On startup the server SHALL load in-process modules through the module host and connect the enabled MCP servers stored in the database before accepting connections, log each loaded module with its tool names and any failed module or MCP server with its error, and warn if `GEMINI_API_KEY` is unset.

#### Scenario: Startup
- **WHEN** the server starts
- **THEN** modules and the tools of stored MCP servers are loaded before the HTTP server listens

#### Scenario: Missing API key
- **WHEN** `GEMINI_API_KEY` is empty
- **THEN** a warning is logged and the server still starts

#### Scenario: Failed module
- **WHEN** a module fails to initialize
- **THEN** the failure is logged with its id and the server still starts

### Requirement: Module listing endpoint

`GET /api/modules` SHALL return a JSON array with one entry per module in core's list: `id`, `label`, `description`, `status` (`loaded`, `failed` or `disabled`), `error` when failed, and `tools` (names). Every stored MCP server SHALL appear with `id` `mcp:<server>` and a `status` of `loaded` when connected, `failed` with `error` when its connection failed, or `disabled` when it is disabled. Failed and disabled servers SHALL have an empty `tools` array.

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

## ADDED Requirements

### Requirement: Cross-origin API writes are refused

The server SHALL answer 403 to any `/api/` request with a method other than GET, HEAD or OPTIONS when the request carries a `Sec-Fetch-Site` header other than `same-origin` or `none`, or an `Origin` header whose host differs from the request's `Host` (including an opaque `null` origin). Requests without either header, such as those from scripts and remote tooling, SHALL be unaffected. This prevents a web page visited on the LAN from changing Friday through the unauthenticated API, for example by adding an MCP server with a CORS simple request.

#### Scenario: Cross-site page adds an MCP server
- **WHEN** a request to `POST /api/mcp/servers` carries `Origin: https://evil.example` and a `text/plain` body defining a server
- **THEN** the response is 403 and no server is stored or connected

#### Scenario: Portal request
- **WHEN** the portal on the same origin sends `POST /api/mcp/servers` with `Sec-Fetch-Site: same-origin`
- **THEN** the request is handled normally

#### Scenario: Reads stay open
- **WHEN** a cross-site request uses GET
- **THEN** it is handled normally

### Requirement: Unexpected route errors answer 500

An error that a route handler does not handle SHALL be logged and answered with 500 and `{ "error": "internal error" }`, and SHALL NOT stop the process.

#### Scenario: Storage failure during a write
- **WHEN** storing an MCP server throws an unexpected database error
- **THEN** the response is 500 and the server keeps serving later requests
