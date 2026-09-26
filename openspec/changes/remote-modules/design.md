# Design

## Context

After `modular-core`, core owns a `ToolRegistry` with owner-tagged tools, `removeOwner`, and per-session snapshots, and `mcp.ts` already turns MCP `tools/list` and `tools/call` into registry tools with prefixing and result flattening. What is missing is a tool source that is *initiated by the module*, survives NAT, and is tied to a live connection.

Constraints:
- Gemini Live fixes the tool list at session open; dynamic tools apply to the next session.
- Remote modules are ephemeral; there must be no state that outlives the connection and no separate registry service (a lesson from Jarvis, where heartbeats and an in-memory registry caused ~60 s windows of missing tools).
- Traefik is not exposed to the internet, but connected modules inject callable tools, so registration still needs a shared secret.

## Goals / Non-Goals

**Goals:**
- One protocol, one endpoint; the WebSocket lifetime is the registration lifetime.
- The same `FridayModule` runs in-process or remote without changes.
- Reuse the MCP client code path so remote tools behave exactly like MCP tools.

**Non-Goals:**
- Remote module UIs. Remote modules are tools only.
- Key management UI or key rotation (change `platform-secrets`).
- Core dialing out to modules, service discovery, or mDNS.
- Live telemetry adapters for specific sims; the simracing package ships a mock source.

## Decisions

### D1. MCP over the WebSocket, module acts as MCP server

```
 gaming PC                                      core
 +---------------------------+                  +----------------------------------+
 | runRemote(module)         |  ws(s)://.../ws/modules                             |
 |  local ToolRegistry       | ---- hello {key, manifest} ------------------------>|
 |  McpServer(tools/list,    | <--- welcome {id} | close 4401 -------------------- | auth: FRIDAY_MODULE_KEYS
 |            tools/call)    |                                                     |
 |  WsServerTransport        | <=== MCP JSON-RPC frames ==========================>| WsClientTransport -> Client
 +---------------------------+                  |   listTools -> registry.add("remote:<id>", "<id>__<tool>")
                                                |   on close  -> registry.removeOwner("remote:<id>")
                                                +----------------------------------+
```

Why MCP rather than a bespoke JSON protocol: `mcp.ts` already converts MCP tools and results; a remote module is then "an MCP server that connected to us". The only bespoke part is the one `hello`/`welcome` handshake before MCP starts. Alternative considered: streamable HTTP MCP with the module hosting a server and core polling a URL. Rejected: NAT, and it needs the module to be reachable.

Both sides implement the SDK `Transport` interface over a `ws` socket (`send` → `ws.send(JSON)`, `onmessage` ← text frames). Binary frames are not used on this endpoint.

### D2. Handshake and authentication

1. Client connects to `/ws/modules`. Core starts a 5 s hello timer.
2. Client sends `{"type":"hello","key":"<secret>","manifest":{...},"protocol":1}`.
3. Core looks up the key in `FRIDAY_MODULE_KEYS` (`id=key,id2=key2`). The key must map to `manifest.id`. Failure → close `4401 unauthorized`; unknown `protocol` → `4400`; no hello in time → `4408`.
4. Core replies `{"type":"welcome","id":"<id>"}` and from then on treats the socket as an MCP transport, runs `Client.connect`, `listTools`, registers tools.
5. If a connection for the same id already exists, the old one is closed with `4409 replaced` first and its tools removed, then the new one registers. This makes module restarts painless.

Keys live in env for now; `platform-secrets` will swap the lookup for stored keys behind the same `KeyStore` interface (`lookup(key) → id | undefined`).

### D3. Naming, scheduling, statuses

- Tool names: `<id>__<tool>`, sanitized exactly like MCP tools (shared helper). Remote collisions are runtime events, so prefixing is mandatory here even though in-process tools are unprefixed.
- Owner: `remote:<id>`.
- Default scheduling: the remote runner attaches `_meta: { "friday/scheduling": "<value>" }` to each MCP tool descriptor from the module's `Tool.scheduling`. Core reads it, falling back to `INTERRUPT`. Per-call `scheduling` and `endConversation` in a returned object work unchanged because results are flattened first.
- `tools/list_changed` notifications trigger `removeOwner` + re-list, so a remote module can change its tools while connected (e.g. only expose pit tools during a race).
- `/api/modules` includes remote entries `{ id, label, status: "connected", tools, connectedAt }`; disconnected remotes are simply absent (no memory of them).

### D4. `runRemote` in `@friday/sdk/remote`

```ts
runRemote(module: FridayModule, opts: { url: string; key: string; env?: Record<string,string> }): { stop(): Promise<void> }
```

It builds a `ModuleContext` whose `defineTool` writes into a local `ToolRegistry`, calls `module.init(ctx)` once, then loops: connect, hello, serve MCP from the local registry, on close wait with exponential backoff (1 s → 30 s, jitter) and reconnect. `dispose()` runs on `stop()`. Ping/pong: core pings using the existing `FRIDAY_WS_PING_MS` logic from the audio transport (extracted into a shared helper) so dead peers are cleaned up.

### D5. Simracing skeleton

`remote/simracing` is a workspace package with a `bin` that reads `FRIDAY_URL` and `FRIDAY_MODULE_KEY` and calls `runRemote`. It defines `TelemetrySource { snapshot(): Promise<Telemetry | null> }` and a `MockTelemetrySource`. Tools return `{ error: "not in a session" }` when telemetry is null. The package is not part of the container image (`.dockerignore`), but is built and tested in CI so it stays green.

### D6. Ingress

Add an IngressRoute for `Host(friday) && PathPrefix(/ws/modules)` on `websecure` only. The plain-HTTP route stays restricted to `/ws/audio` for the Voice PE.

## Risks / Trade-offs

- [Key in env is static and shared] → Acceptable on the LAN for now; per-module keys and rotation come with `platform-secrets`, behind the `KeyStore` seam so the protocol does not change.
- [Tool churn is invisible to an open session] → Documented; the model never sees a half-updated list because each session snapshots.
- [MCP SDK concurrency over a single transport] → One `Client` per connection, requests are multiplexed by JSON-RPC id, which the SDK handles. Jarvis's per-request server instances were a workaround for stateless HTTP, not needed here.
- [Slow or flaky remote handler] → `callTool` already catches errors; add a per-call timeout (`FRIDAY_REMOTE_CALL_TIMEOUT_MS`, default 10 s) returning `{ error: "timeout" }` so a frozen game PC cannot hang a turn.

## Open Questions

- Which sim comes first (iRacing SDK, ACC shared memory, other)? Does not affect this change; the mock source is the deliverable and the adapter is a follow-up module task.
