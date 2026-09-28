# Spec Delta

## ADDED Requirements

### Requirement: Stored server definitions

MCP servers SHALL be defined in core's database and nowhere else. A server definition SHALL have a unique `name` matching `^[A-Za-z][A-Za-z0-9_-]{0,31}$`, an `enabled` flag (default `true`), a `transport` of `stdio` (with `command`, optional `args`, optional `env` entries) or `http` (with `url`, optional `headers` entries), and optional `include`, `exclude`, `scheduling` (`INTERRUPT`, `WHEN_IDLE` or `SILENT`) and `prefix`. Each `env` or `headers` entry SHALL be `{ name, value, secret }`. Definitions SHALL persist across restarts. Enabled servers SHALL be connected at startup. Disabled servers SHALL NOT be connected and SHALL register no tools.

#### Scenario: No servers configured
- **WHEN** the database holds no MCP server definitions
- **THEN** no MCP tools are registered and startup continues silently

#### Scenario: Definition survives restart
- **WHEN** server `home` is created and Friday restarts
- **THEN** `home` is connected again at startup with the same definition

#### Scenario: Disabled server
- **WHEN** server `home` has `enabled: false`
- **THEN** it is not connected and no `home__*` tools are registered

### Requirement: Secret header and env values

An `env` or `headers` entry marked `secret: true` SHALL be stored encrypted with AES-256-GCM using `FRIDAY_MASTER_KEY`, and its value SHALL never be returned by the API or written to logs. Plain entries SHALL be stored and returned as plaintext and SHALL NOT depend on the master key. When `FRIDAY_MASTER_KEY` is unset, a write that supplies a new secret value SHALL fail with 503 and a message. An enabled server with a secret entry that cannot be decrypted, or with secret entries while the master key is unset, SHALL be reported `failed` with an error naming the entry, and its value SHALL NOT be logged.

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
- **WHEN** a server's secret entries were encrypted with a different key
- **THEN** startup logs the failure without the value, the server is reported `failed`, and other servers load normally

### Requirement: MCP server API

`GET /api/mcp/servers` SHALL return `{ secretsEnabled, servers }`. Each server SHALL include its definition (secret entries without `value`), `status` (`loaded`, `failed` or `disabled`), `error` when failed, `tools` (registered names) and `updatedAt`. `POST /api/mcp/servers` SHALL create a server and respond 201. `PUT /api/mcp/servers/:name` SHALL replace the definition of an existing server and respond 200. `DELETE /api/mcp/servers/:name` SHALL remove it and its stored secrets and respond 204. `POST /api/mcp/servers/:name/reconnect` SHALL reconnect an enabled server and respond 200. Create, update and reconnect responses SHALL carry the server entry after its connection attempt. A server's `name` SHALL NOT change after creation. In a write, a secret entry without a `value` SHALL keep the stored value for that entry name, and entries left out of the write SHALL be removed. A definition that fails validation SHALL respond 400 with a message, a duplicate name 409, and an unknown name 404.

#### Scenario: Create a server
- **WHEN** a client posts `{ name: "home", transport: "http", url: "https://ha.example/api/mcp", headers: [{ name: "Authorization", value: "Bearer abc", secret: true }] }`
- **THEN** the response is 201 with status `loaded` and the `home__*` tool names

#### Scenario: Edit without re-entering the secret
- **WHEN** `home` is updated with `scheduling: "SILENT"` and the `Authorization` entry sent as `{ name: "Authorization", secret: true }` without a value
- **THEN** the stored token is kept and the server reconnects with it

#### Scenario: Missing transport field
- **WHEN** a write has `transport: "http"` without `url`, or `transport: "stdio"` without `command`
- **THEN** the response is 400 explaining the missing field

#### Scenario: Secret entry without a stored value
- **WHEN** a write sends a secret entry without a `value` and no value is stored for that entry name
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

## MODIFIED Requirements

### Requirement: Servers are connected concurrently and failures are isolated

At startup all enabled servers SHALL be connected in parallel. A server that fails to connect or list tools SHALL be logged with its name, reported `failed` with its error, and SHALL NOT prevent other servers or the application from starting. A connection attempt SHALL time out after 10 seconds and the server SHALL be reported `failed`. When a server is created, updated, reconnected, disabled or deleted at runtime, only that server SHALL be affected: its existing client is closed and its tools removed, then it connects again with the current definition if it is enabled. Voice sessions that are already open SHALL keep their tool snapshot; the next session SHALL see the new tools.

#### Scenario: One server down
- **WHEN** one of several configured servers is unreachable
- **THEN** its error is logged, it is reported `failed`, and the other servers' tools are registered normally

#### Scenario: Stdio server
- **WHEN** a server uses the `stdio` transport
- **THEN** it is spawned with `command` and `args` and the process environment merged with its `env` entries

#### Scenario: HTTP server
- **WHEN** a server uses the `http` transport
- **THEN** a streamable HTTP connection is made to `url` with its `headers` entries

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

## REMOVED Requirements

### Requirement: Configuration file

**Reason**: MCP servers are now stored in the database and managed through the API and the portal, so secrets can be encrypted and changes apply without a restart.

**Migration**: Re-create each server from `mcp.json` in `Settings > Configuration > MCP servers` (or through `POST /api/mcp/servers`), marking tokens as secret. Then delete `mcp.json`, unset `FRIDAY_MCP_CONFIG`, and remove the `friday-mcp` k8s Secret and its volume.
