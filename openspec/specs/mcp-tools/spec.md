# MCP Tools

## Purpose

Tools from external Model Context Protocol servers are registered in the shared tool registry so Gemini sees them identically to native tools. Servers are reached over streamable HTTP, stored in `friday.db` with their headers (tokens encrypted), and managed through `/api/mcp/servers` and the portal's `Settings > Configuration > MCP servers` tab.

## Requirements

### Requirement: Servers are connected concurrently and failures are isolated

At startup all enabled servers SHALL be connected in parallel over streamable HTTP, sending their headers. A server that fails to connect or list tools SHALL be logged with its name, reported `failed` with its error, and SHALL NOT prevent other servers or the application from starting. A connection attempt SHALL time out after 10 seconds and the server SHALL be reported `failed`. When a server is created, updated, reconnected, disabled or deleted at runtime, only that server SHALL be affected: its existing client is closed and its tools removed, then it connects again with the current definition if it is enabled. Voice sessions that are already open SHALL keep their tool snapshot; the next session SHALL see the new tools. On shutdown, reconnects already in progress SHALL finish before clients are closed, and none SHALL start afterwards.

#### Scenario: One server down
- **WHEN** one of several configured servers is unreachable
- **THEN** its error is logged, it is reported `failed`, and the other servers' tools are registered normally

#### Scenario: Stdio server
- **WHEN** a write asks for a stdio server (`transport: "stdio"` or a `command`)
- **THEN** it is rejected with 400 explaining that only MCP servers reachable over HTTP are supported, and no process is started

#### Scenario: HTTP server
- **WHEN** a server is connected
- **THEN** a streamable HTTP connection is made to `url` with its headers

#### Scenario: Hanging server
- **WHEN** a server accepts the connection but never answers
- **THEN** after 10 seconds it is reported `failed` with a timeout error and the API request or startup continues

#### Scenario: Update one server
- **WHEN** `home` is updated while `fs` is connected
- **THEN** `home` reconnects with the new definition and `fs` keeps its client and tools

#### Scenario: Update during a session
- **WHEN** a server is updated while a voice session is open
- **THEN** the session keeps its tool snapshot and the next session sees the updated tools

#### Scenario: Reconnect after the server comes back
- **WHEN** `home` failed at startup, its server is now reachable, and reconnect is called
- **THEN** it reports `loaded` and its tools are registered

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

### Requirement: Stored server definitions

MCP servers SHALL be defined in core's database and nowhere else, and SHALL be reached over streamable HTTP only; core SHALL NOT start processes for MCP servers. A server definition SHALL have a unique `name` matching `^[A-Za-z][A-Za-z0-9_-]{0,31}$`, an `enabled` flag (default `true`), a `url` (http or https), optional `headers` entries, and optional `include`, `exclude`, `scheduling` (`INTERRUPT`, `WHEN_IDLE` or `SILENT`) and `prefix`. Each header entry SHALL be `{ name, value, secret }`. Definitions SHALL persist across restarts. Enabled servers SHALL be connected at startup. Disabled servers SHALL NOT be connected and SHALL register no tools.

#### Scenario: No servers configured
- **WHEN** the database holds no MCP server definitions
- **THEN** no MCP tools are registered and startup continues silently

#### Scenario: Definition survives restart
- **WHEN** server `home` is created and Friday restarts
- **THEN** `home` is connected again at startup with the same definition

#### Scenario: Disabled server
- **WHEN** server `home` has `enabled: false`
- **THEN** it is not connected and no `home__*` tools are registered

### Requirement: Secret header values

A header marked `secret: true` SHALL be stored encrypted with AES-256-GCM using `FRIDAY_MASTER_KEY`, and its value SHALL never be returned by the API or written to logs. Plain headers SHALL be stored and returned as plaintext and SHALL NOT depend on the master key. Header values containing line breaks or other control characters SHALL be rejected with 400. When `FRIDAY_MASTER_KEY` is unset, a write that supplies a new secret value SHALL fail with 503 and a message. An enabled server with a secret header that cannot be decrypted, or with secret headers while the master key is unset, SHALL be reported `failed` with an error naming the header, and its value SHALL NOT be logged.

#### Scenario: Bearer token stored as secret
- **WHEN** server `home` is saved with header `Authorization` = `Bearer abc`, `secret: true`
- **THEN** the stored row is ciphertext, the connection sends `Authorization: Bearer abc`, and `GET /api/mcp/servers` shows the header with `secret: true` and no value

#### Scenario: Plain header visible
- **WHEN** a header `X-Client` = `friday` is saved with `secret: false`
- **THEN** `GET /api/mcp/servers` returns its value

#### Scenario: No master key
- **WHEN** `FRIDAY_MASTER_KEY` is unset and a write supplies a secret header value
- **THEN** the response is 503 and the stored definition is unchanged

#### Scenario: Wrong master key
- **WHEN** a server's secret headers were encrypted with a different key
- **THEN** startup logs the failure without the value, the server is reported `failed`, and other servers load normally

### Requirement: MCP server API

`GET /api/mcp/servers` SHALL return `{ secretsEnabled, servers }`. Each server SHALL include its definition (secret headers without `value`), `status` (`loaded`, `failed` or `disabled`), `error` when failed, `tools` (registered names) and `updatedAt`. `POST /api/mcp/servers` SHALL create a server and respond 201. `PUT /api/mcp/servers/:name` SHALL replace the definition of an existing server and respond 200. `DELETE /api/mcp/servers/:name` SHALL remove it and its stored secrets and respond 204. `POST /api/mcp/servers/:name/reconnect` SHALL reconnect an enabled server and respond 200. Create, update and reconnect responses SHALL carry the server entry after its connection attempt. A server's `name` SHALL NOT change after creation. In a write, a secret header without a `value` SHALL keep the stored value for that header name, and headers left out of the write SHALL be removed. A definition that fails validation SHALL respond 400 with a message, a duplicate name 409, and an unknown name 404.

#### Scenario: Create a server
- **WHEN** a client posts `{ name: "home", url: "https://ha.example/api/mcp", headers: [{ name: "Authorization", value: "Bearer abc", secret: true }] }`
- **THEN** the response is 201 with status `loaded` and the `home__*` tool names

#### Scenario: Edit without re-entering the secret
- **WHEN** `home` is updated with `scheduling: "SILENT"` and the `Authorization` header sent as `{ name: "Authorization", secret: true }` without a value
- **THEN** the stored token is kept and the server reconnects with it

#### Scenario: Missing url
- **WHEN** a write has no `url`, or a `url` that is not http or https
- **THEN** the response is 400 explaining the problem

#### Scenario: Secret header without a stored value
- **WHEN** a write sends a secret header without a `value` and no value is stored for that header name
- **THEN** the response is 400

#### Scenario: Invalid name
- **WHEN** a client posts a server named `home assistant`
- **THEN** the response is 400

#### Scenario: Duplicate name
- **WHEN** a client posts a server named `home` and `home` already exists
- **THEN** the response is 409

#### Scenario: Delete
- **WHEN** `DELETE /api/mcp/servers/home` is called
- **THEN** the response is 204, its tools are removed, and it no longer appears in either listing
