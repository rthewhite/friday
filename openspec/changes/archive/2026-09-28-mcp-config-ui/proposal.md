# Proposal

## Why

MCP servers are the only part of Friday still configured through a file: `mcp.json`, mounted in k8s from a hand-made `friday-mcp` Secret, with bearer tokens in plaintext and a pod restart for every change. Module configuration and secrets already live in `friday.db` and are edited in the portal, so MCP servers should work the same way: add, edit and remove them in `Settings > Configuration`, with their authentication secret stored encrypted.

## What Changes

- **BREAKING**: `mcp.json` and `FRIDAY_MCP_CONFIG` are removed. MCP server definitions are stored in `friday.db` (new migration) and are the only source. Existing servers must be re-entered in the portal.
- A server definition keeps today's HTTP fields: name, `url`, `headers`, `include`, `exclude`, `scheduling`, `prefix`. It also gains an `enabled` flag.
- **BREAKING**: stdio servers (a `command` Friday spawns) are no longer supported. The portal has no login, so defining commands there would let anyone on the network run code in Friday's container; no stdio server is in use today.
- Individual header values can be marked **secret**. Secret values are encrypted with `FRIDAY_MASTER_KEY` (AES-256-GCM, like config secrets), are write-only, and are never returned by the API. When the master key is unset, saving a secret value fails with 503 and plain values keep working.
- New API `/api/mcp/servers` to list, create, update and delete servers. Saving or deleting a server reconnects or disconnects only that server at runtime, without a restart. Open voice sessions keep their tool snapshot.
- `GET /api/modules` reports every configured MCP server, not just the connected ones: `loaded`, `failed` with the connection error, or `disabled`.
- The portal's `Settings > Configuration` page gets a third pill tab, `MCP servers`. It shows a table of servers (status, name, URL, tool count). Clicking a row opens a drawer for editing the definition, its headers (each marked plain or secret), and the filters, with `Save`, `Delete` and a connection-error display.
- The k8s manifest drops the `friday-mcp` Secret volume and the `FRIDAY_MCP_CONFIG` env var. The README and `.env.example` are updated.

## Capabilities

### New Capabilities

_None._ MCP configuration stays within the existing `mcp-tools` capability.

### Modified Capabilities

- `mcp-tools`: "Configuration file" is replaced by database-stored HTTP server definitions with secret header values (encrypted with the same AES-256-GCM scheme as config secrets), a CRUD API, and per-server reconnect on change. Failure isolation now also covers runtime reconnects.
- `secret-management`: "Configuration page" gains the `MCP servers` tab and its drawer.
- `http-server`: `/api/modules` lists all configured MCP servers with `loaded`, `failed` or `disabled` status and an error, instead of always `loaded`. The startup requirement attaches MCP servers from storage.

## Impact

- **Core**: `packages/core/src/tools/mcp.ts` (load from storage; `connect`/`disconnect` per server), new MCP server store and migration in `packages/core/src/storage`, reuse of `packages/core/src/secrets/crypto.ts`, new routes in `packages/core/src/app.ts`, `moduleListing` status, and startup in `server.ts`.
- **Portal**: `packages/portal/src/pages/settings/ConfigurationPage.vue` (new tab), and probably a new MCP server drawer component built from `@friday/portal-ui` parts.
- **Deploy**: `deploy/k8s.yaml` loses the `mcp` volume and `FRIDAY_MCP_CONFIG`. After upgrading, re-enter the `home` server in the portal, then delete the `friday-mcp` Secret by hand. `FRIDAY_MASTER_KEY` must be set to store the auth token.
- **Docs**: README MCP section, `.env.example`, the `mcp.json` example, and the header comment in `mcp.ts`.
- **Tests**: MCP source tests move from file fixtures to the store. New API tests cover secret masking and 503 without a master key.
