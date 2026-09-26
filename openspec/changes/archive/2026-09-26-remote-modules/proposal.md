# Proposal

## Why

Some of Friday's capabilities only exist while another machine is doing something: a simracing telemetry module on the gaming PC is useful only during a race, and that PC is behind NAT and often off. Core cannot dial out to it. We want a module to start anywhere on the network, connect to Friday, register its tools, and disappear cleanly when it stops, so Friday's abilities follow the environment the user is in.

## What Changes

- Core gains a `/ws/modules` WebSocket endpoint where remote modules connect, authenticate with a pre-shared API key, announce their manifest, and then serve their tools over MCP on that same socket. Tools are registered with owner `remote:<id>` and name prefix `<id>__` while the socket is open and removed when it closes.
- `@friday/sdk/remote` adds `runRemote(module, { url, key })`: runs an unchanged `FridayModule` as a remote, with reconnect and backoff. The same module code can run in-process or remotely.
- API keys come from the `FRIDAY_MODULE_KEYS` environment variable in this change (`<id>=<key>` pairs). Portal-managed keys replace this in `platform-secrets`.
- A remote module connecting with an id already connected replaces the previous connection.
- Remote tool scheduling defaults travel in MCP tool metadata; per-call `scheduling` and `endConversation` keys work as for any tool because MCP results are flattened before reserved-key resolution.
- New tool sets are visible to the next voice session, never the current one (Gemini binds tools at session open). `/api/modules` shows remote modules with status `connected`.
- Traefik gets a `websecure` route for `/ws/modules`; the k8s Secret gains `FRIDAY_MODULE_KEYS`.
- `remote/simracing` is added as a runnable skeleton: a `TelemetrySource` interface, a mock source, and tools such as `get_race_position`, `get_gap_ahead`, `get_fuel_remaining`. Real sim adapters are follow-up work.

## Capabilities

### New Capabilities
- `remote-modules`: the `/ws/modules` protocol (hello, authentication, MCP over the socket, replacement, disconnect cleanup), remote tool naming and scheduling, and the sdk remote runner.

### Modified Capabilities
- `module-system`: the module contract gains a second host (remote runner) and the manifest gains optional `scheduling` defaults per tool via the sdk; `/api/modules` statuses gain `connected`.
- `http-server`: upgrades `/ws/modules` and reports remote modules in `/api/modules`.

## Impact

- Depends on `modular-core` (registry owners, `removeOwner`, `onChange`, module contract, MCP result flattening).
- New code in `packages/core` (remote host, WS-backed MCP client transport), `packages/sdk` (`remote` export with WS-backed MCP server transport), new `remote/simracing` package, `deploy/k8s.yaml` route and secret key, `.env.example`, README.
- Reuses `@modelcontextprotocol/sdk` and `ws`, already dependencies. The sdk gains an optional peer dependency on both for the `remote` entry point only.
- Security posture: Traefik is LAN-only; keys still gate registration because a connected module can define tools the model will call.
