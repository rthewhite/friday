# Remote Modules

## Purpose

Lets a module running on another machine connect to Friday over a WebSocket, authenticate with an API key, announce its manifest, and serve its tools over MCP for as long as the connection lives, so Friday's capabilities can follow the user's environment.

## Requirements

### Requirement: Remote module endpoint and handshake

Core SHALL accept WebSocket connections on `/ws/modules`. The first client frame SHALL be a JSON `hello` with `key`, `manifest` and `protocol: 1`. Core SHALL answer `{"type":"welcome","id":"<id>"}` on success. Core SHALL close with `4408` if no hello arrives within 5 seconds, `4400` for an unsupported protocol or malformed hello, and `4401` when the key is unknown or does not belong to `manifest.id`.

#### Scenario: Valid hello
- **WHEN** a client sends a hello whose key maps to `simracing` and whose manifest id is `simracing`
- **THEN** it receives `welcome` with id `simracing`

#### Scenario: Wrong key
- **WHEN** a client sends a hello with a key that maps to a different id or no id
- **THEN** the socket is closed with code 4401 and nothing is registered

#### Scenario: No hello
- **WHEN** a client connects and sends nothing for 5 seconds
- **THEN** the socket is closed with code 4408

### Requirement: Keys are resolved through a key store

Core SHALL resolve keys through a `KeyStore` with `lookup(key) → id | undefined`. The default store SHALL parse `FRIDAY_MODULE_KEYS` as comma-separated `<id>=<key>` pairs. When the variable is unset, every hello SHALL be rejected with 4401 and a startup warning SHALL note that remote modules are disabled.

#### Scenario: Env keys
- **WHEN** `FRIDAY_MODULE_KEYS=simracing=abc,lab=def`
- **THEN** `lookup("def")` returns `lab`

#### Scenario: No keys configured
- **WHEN** `FRIDAY_MODULE_KEYS` is unset
- **THEN** startup logs a warning and any hello is closed with 4401

### Requirement: Tools are served over MCP on the same socket

After `welcome`, all frames SHALL be MCP JSON-RPC messages with the remote module acting as MCP server and core as client. Core SHALL call `tools/list`, register each tool as `<id>__<tool>` (sanitized as for MCP tools) with owner `remote:<id>`, using the MCP `inputSchema` as `parametersJsonSchema` and the `_meta["friday/scheduling"]` value as default scheduling (falling back to `INTERRUPT`). Calls SHALL be forwarded as `tools/call` and results flattened like MCP results.

#### Scenario: Registration
- **WHEN** remote `simracing` lists `get_race_position` with `_meta["friday/scheduling"]: "WHEN_IDLE"`
- **THEN** the registry contains `simracing__get_race_position` owned by `remote:simracing` with default scheduling `WHEN_IDLE`

#### Scenario: Call
- **WHEN** the model calls `simracing__get_race_position`
- **THEN** core sends `tools/call` for `get_race_position` and returns the flattened result

#### Scenario: Tool list changed
- **WHEN** the remote sends `notifications/tools/list_changed`
- **THEN** core removes owner `remote:simracing` tools and re-registers from a fresh `tools/list`

### Requirement: Disconnect removes tools

When the socket closes for any reason, core SHALL remove every tool owned by `remote:<id>` and log the disconnect. Core SHALL ping the socket using the configured WebSocket ping interval and terminate unresponsive peers.

#### Scenario: Module stops
- **WHEN** the simracing process exits
- **THEN** within one ping interval its tools are gone from `declarations()` and `/api/modules`

### Requirement: Reconnecting with the same id replaces the previous connection

When a hello arrives for an id that is already connected, core SHALL close the existing socket with `4409 replaced`, remove its tools, then register the new connection.

#### Scenario: Restart
- **WHEN** simracing reconnects while its old socket is still open
- **THEN** the old socket receives close code 4409 and the registry holds exactly one set of `simracing__*` tools

### Requirement: Remote calls time out

A `tools/call` that does not answer within `FRIDAY_REMOTE_CALL_TIMEOUT_MS` (default 10000) SHALL resolve to `{ error: "timeout" }` with scheduling `INTERRUPT`.

#### Scenario: Frozen remote
- **WHEN** the remote never answers a call
- **THEN** after the timeout the model receives `{ error: "timeout" }`

### Requirement: Remote modules appear in the module listing

`/api/modules` SHALL include each connected remote as `{ id, label, description, status: "connected", tools, connectedAt }`. Disconnected remotes SHALL NOT be listed.

#### Scenario: Connected
- **WHEN** simracing is connected
- **THEN** `/api/modules` includes it with status `connected` and its prefixed tool names

### Requirement: Dynamic tools apply to the next voice session

Tools added or removed by remote modules SHALL be visible to sessions opened afterwards only. The README SHALL state this.

#### Scenario: Join during a conversation
- **WHEN** simracing connects while a session is open
- **THEN** that session cannot call its tools and the next session can

### Requirement: SDK remote runner

`@friday/sdk/remote` SHALL export `runRemote(module, { url, key, env? })` which initializes the module once against a local registry, connects to `url`, performs the hello, serves MCP from the local registry including scheduling metadata, reconnects with exponential backoff (1 s to 30 s with jitter) after any close except 4401 and 4400, and returns `{ stop() }` which disposes the module and closes the socket.

#### Scenario: Run a module remotely
- **WHEN** `runRemote(builtinModule, { url, key })` is called against a test core
- **THEN** core registers `builtin__get_current_time` and a call returns the same result as in-process

#### Scenario: Unauthorized does not retry
- **WHEN** core closes with 4401
- **THEN** the runner logs the rejection and does not reconnect

#### Scenario: Network drop
- **WHEN** the socket closes with a network error
- **THEN** the runner reconnects after backoff and tools are re-registered
