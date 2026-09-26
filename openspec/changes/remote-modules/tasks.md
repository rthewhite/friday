# Tasks

## 1. Shared transport helpers

- [x] 1.1 Extract the ping/pong keep-alive from `transports/ws.ts` into a shared `keepAlive(ws, intervalMs)` helper used by both endpoints; verify existing `ws.test.ts` keep-alive tests still pass
- [x] 1.2 Move MCP tool-name sanitizing, prefixing and result flattening from `mcp.ts` into `packages/core/src/tools/mcp-shared.ts`; verify `mcp.ts` behaviour is unchanged by running its tests
- [x] 1.3 Implement `WsClientTransport` (core) and `WsServerTransport` (sdk) over a `ws` socket for the MCP SDK `Transport` interface; verify a unit test round-trips a `tools/list` request between the two over an in-memory socket pair

## 2. Core remote host

- [x] 2.1 Implement `KeyStore` with the `FRIDAY_MODULE_KEYS` parser and startup warning when unset; verify tests cover parsing, unknown key, and the unset case
- [x] 2.2 Implement the `/ws/modules` handshake (hello timer 4408, malformed/protocol 4400, unauthorized 4401, id mismatch 4401, welcome); verify tests for each close code
- [x] 2.3 Register tools after welcome (`remote:<id>` owner, `<id>__` prefix, `_meta["friday/scheduling"]`), forward calls with `FRIDAY_REMOTE_CALL_TIMEOUT_MS`, handle `tools/list_changed`; verify tests for registration, call, timeout, and re-list
- [x] 2.4 Remove tools on close, keep-alive ping, replace-on-duplicate with 4409, close all with 1001 on shutdown; verify tests for disconnect cleanup, replacement, and shutdown
- [x] 2.5 Add remote entries to `/api/modules` with `connectedAt`; verify an integration test shows a remote appearing and disappearing

## 3. SDK remote runner

- [x] 3.1 Implement `runRemote` under `@friday/sdk/remote` (local registry, hello, MCP server with scheduling metadata, backoff 1–30 s with jitter, no retry on 4400/4401, `stop()` disposes); verify tests against a stub core for success, unauthorized, and reconnect
- [x] 3.2 Write `packages/sdk/README.md` section "Running a module remotely" with a complete example; verify the example compiles in a doc test
- [x] 3.3 Integration test: start core with a test key, run the builtin module through `runRemote`, assert `builtin__get_current_time` registers and returns the same result as in-process; verify it passes in `pnpm -r test`

## 4. Simracing skeleton

- [x] 4.1 Create `remote/simracing` with `TelemetrySource`, `MockTelemetrySource`, tools `get_race_position`, `get_gap_ahead`, `get_gap_behind`, `get_fuel_remaining`, `get_lap_info`, and a `bin` reading `FRIDAY_URL` and `FRIDAY_MODULE_KEY`; verify `createTestHost` tests cover each tool with mock telemetry and the `not in a session` error
- [x] 4.2 Add `remote/simracing/README.md` with Windows run instructions; verify `pnpm --filter @friday/remote-simracing start` connects to a local core and its tools appear in `/api/modules`
- [x] 4.3 Exclude `remote/` from the container image via `.dockerignore` and confirm CI builds and tests it; verify the image size is unchanged and CI passes

## 5. Deploy and docs

- [x] 5.1 Add the `websecure` IngressRoute for `/ws/modules` and `FRIDAY_MODULE_KEYS` to the secret documentation in `infra/README.md` and `.env.example`; verify `kubectl apply --dry-run=client` passes
- [x] 5.2 Document remote modules in `README.md` including "new tools apply to the next conversation"; verify the documented `wss://` connection works from another machine on the LAN

## 6. Integration check

- [ ] 6.1 With core deployed, start the simracing skeleton on the gaming PC, start a voice session, and ask for the race position; then stop the module and confirm the next session no longer offers the tool; verify by log output and `/api/modules`
