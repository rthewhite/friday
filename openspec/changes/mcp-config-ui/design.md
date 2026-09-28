# Design

## Context

See proposal.md (Why) for motivation and the delta specs for required behaviour.

Current state:

- `McpSource` (`packages/core/src/tools/mcp.ts`) reads `mcp.json` once in `load()` and connects every server in parallel. It keeps only the `Client`s that connected. A failed server is logged and then forgotten, so `/api/modules` can only report connected servers, all as `loaded`. There's no way to connect or disconnect a single server.
- Encryption already exists. `secrets/crypto.ts` provides AES-256-GCM `encrypt`/`decrypt` with `scope:key` as AAD. `ConfigStore` shows the pattern for plain and secret rows, a missing master key (`ConfigStoreDisabled` → 503) and boot-time `verifyAll()`.
- `friday.db` has versioned migrations (currently at 4) in `storage/db.ts`.
- The portal has no authentication. The Configuration page (`ConfigurationPage.vue`, ~190 lines) already has pill tabs, a drawer, native `<select>` controls and a secrets banner. `@friday/portal-ui` has no toggle or select component.
- Tests in `mcp.test.ts` use file fixtures. `remote-host.test.ts` already builds MCP `Server`s from the SDK, which gives a pattern for real in-process servers.

## Goals / Non-Goals

**Goals:**
- One owner for MCP server lifecycle state per server: `loaded`, `failed` with an error, or `disabled`. Both `/api/modules` and `/api/mcp/servers` read from it.
- Changes at runtime affect one server and are serialized per server. Two quick saves must not race each other into two clients.
- Secret values never leave core in plaintext: not over the API, not in logs, and not in error messages.

**Non-Goals:**
- Importing an existing `mcp.json`. The user re-enters servers by hand.
- Portal authentication, or gating stdio servers. Anyone who can reach the portal can define a stdio command; see Risks.
- Choosing tools from a live tool list in the drawer. `include`/`exclude` stay free-text lists.
- OAuth flows for MCP servers. Authentication is static headers or env values only.
- Adding new form components to `@friday/portal-ui`.

## Decisions

### D1. Separate tables, not `config_values`

Migration 5 `mcp-servers` adds two tables:

- `mcp_servers (name PK, enabled, transport, command, args_json, url, include_json, exclude_json, scheduling, prefix, created_at, updated_at)`
- `mcp_server_entries (server FK → mcp_servers ON DELETE CASCADE, kind 'env'|'header', name, position, secret, plaintext, ciphertext, iv, tag, PRIMARY KEY (server, kind, name))`

The entries table holds both plain and secret values in the same layout as `config_values`. `position` preserves the order the user entered them in.

*Alternative:* store secrets in `config_values` under scope `mcp:<name>`. That would reuse `ConfigStore` completely, but those rows would show up in `/api/config` and the Secrets tab, would need `mcp:` exempted from scope validation, and deleting a server would mean cleaning up rows across two tables. A cascading FK in one place is simpler and can't leave orphan secrets behind.

### D2. `McpServerStore` reuses `crypto.ts` with a server-specific AAD

A new `McpServerStore(db, masterKey)` sits next to `McpSource` in `tools/`. Its methods:

- `list()` returns definitions only. Secret entries come back as `{ name, secret: true }`, with no value.
- `resolve(name)` returns the runtime config with decrypted values. It throws `secret header "Authorization" cannot be decrypted` (or `… requires FRIDAY_MASTER_KEY`) and never includes the value.
- `create(input)`, `update(name, input)` and `delete(name)`, each run in one transaction.

The AAD is `mcp:<server>` / `<kind>:<name>`, via `encrypt(masterKey, "mcp:" + server, kind + ":" + name, value)`. A ciphertext therefore can't be moved to another server or entry.

Merge rules on update (entries are replaced as a set):

| Incoming entry | Stored entry | Result |
|---|---|---|
| plain + value | any | stored plain |
| secret + value | any | encrypted (503 if no master key) |
| secret, no value | secret | ciphertext kept as-is (no master key needed) |
| secret, no value | plain | stored plaintext encrypted (503 if no master key) |
| secret, no value | none | 400 |
| plain, no value | any | 400 |
| not in input | any | deleted |

`McpStoreDisabled` mirrors `ConfigStoreDisabled`, so the route maps it to 503 the same way.

### D3. Validation is a pure function

`parseServerInput(body, { creating })` returns a typed definition or throws `McpInputError` (→ 400). It checks:

- the name regex, and that the name is only present on create;
- `transport` is `stdio` or `http`, with the matching `command` or `url` present; the URL must parse as http(s);
- string arrays for `args`, `include` and `exclude`;
- `scheduling` is `INTERRUPT`, `WHEN_IDLE` or `SILENT`;
- entry names: env names match `^[A-Za-z_][A-Za-z0-9_]*$`, header names are HTTP token characters, and there are no duplicates within a kind.

Fields that don't belong to the chosen transport are dropped, not rejected, so the UI can switch transports without clearing fields. The store turns a duplicate name on create into 409.

### D4. `McpSource` becomes a per-server state machine

`McpSource(registry, store, { timeoutMs = 10_000, log })` holds a `Map<name, { status, error?, client? }>`.

- `load()` runs `apply(name)` for every stored server in parallel. Disabled servers are recorded as `disabled` without connecting.
- `apply(name)` is the single entry point for create, update, reconnect and delete. It:
  1. removes the owner's tools and closes any existing client;
  2. reloads the definition from the store;
  3. if the server is enabled, calls `resolve()` and connects;
  4. records the state.

  A deleted server's state is removed.
- **Per-server serialization.** A `Map<name, Promise>` chains `apply` calls per name, so concurrent saves run one after another. Different servers run in parallel.
- **Timeout.** `connect()` and `listTools()` share one deadline via a `withTimeout` helper. On timeout the client is closed, which kills a stdio child process or aborts HTTP, and the error is `timed out after 10s`. `timeoutMs` can be set so tests stay fast.
- **Registration only on full success.** Tools are registered only after `listTools` succeeds, so a failure never leaves half a server's tools in the registry.
- `servers()` returns `[{ name, status, error?, tools }]` from the state map, and `moduleListing` maps these onto `ApiModuleEntry` (see the http-server delta). The portal Modules page already colours `failed` and `disabled`.
- Open sessions keep their snapshot for free. `GeminiSession` snapshots `declarations()` when it opens, so `removeOwner` + `add` only affects later sessions.

*Alternative:* reconnect everything on any change. That's simpler, but it drops every MCP tool for up to 10 seconds and contradicts the "only that server" requirement.

### D5. Routes wait for the connection attempt

The `/api/mcp/servers` routes are added in `app.ts`, and `AppDeps` gains `mcpStore`. The write flow is: parse, write to the store, `await mcp.apply(name)`, respond with the merged entry (definition + state).

A save can therefore take up to 10 seconds. The drawer's `Save` button shows a busy state. In return the response carries the real status and error, and the UI needs no polling.

`reconnect` on a disabled server is a no-op that returns the entry with status `disabled`. `GET` includes `secretsEnabled` from the store, so the tab doesn't need `/api/config`.

### D6. Startup and shutdown

In `server.ts`, `McpServerStore` is created next to `ConfigStore` with the same parsed master key. It keeps `await mcp.load()` after `host.load()`. Decryption failures surface as `failed` servers with a logged, value-free error, so no separate `verifyAll` is needed. `close()` goes through the state map.

`FRIDAY_MCP_CONFIG` is removed from `config.ts` and `.env.example`, and the file path argument to `load()` goes away.

### D7. Portal: a separate tab component

`ConfigurationPage.vue` gains the tab `mcp` (label `MCP servers`, count = number of servers) and renders a new `pages/settings/McpServersTab.vue`. That component owns the table, drawer and API calls, which keeps the existing page from doubling in size. `?tab=mcp&server=<name>` follows the page's existing `?key=` pattern.

Drawer controls use the same native `<select>`, checkbox and `surface-inset` styling as the current page:

- `args`, `include` and `exclude` are textareas with one item per line, since args can contain spaces.
- Env and headers are a row list of name, value, a secret checkbox and a remove button. A stored secret renders as a password input with placeholder `•••••• stored, leave blank to keep`, and sends `{ name, secret: true }` when left blank.
- Without a master key, secret checkboxes on new rows are disabled and the existing secrets banner is shown.
- `Delete` is a two-step button (`Delete` → `Confirm delete`) rather than `window.confirm`.

### D8. Testing

- `mcp.test.ts` moves to an in-memory `openDatabase` (temp dir) plus the SDK `Server` over `StreamableHTTPServerTransport` on an ephemeral port. That exercises the real HTTP path, including a check that the `Authorization` header arrives.
- The timeout test uses a server that never answers `listTools`, with `timeoutMs: 50`.
- Store tests cover the merge table in D2, AAD binding (swapping a ciphertext between entries fails), and the wrong-master-key path.
- API tests in `app.test.ts` cover 201/200/204/400/404/409/503 and assert that no response body contains a secret value.

## Risks / Trade-offs

- **[Accepted] Anyone who can reach the portal can run commands through stdio servers.** The portal has no authentication, and a stdio definition spawns an arbitrary command in the container. Before this change that took cluster access. The user chose to treat the portal as a trusted, LAN-only admin surface. → Documented in the README MCP section; revisit if the portal gets authentication or is exposed beyond the LAN.
- **[Risk] Secrets can leak through error messages.** An MCP SDK or transport error might echo request details. → Store and resolve errors are built from entry names only. Errors reported for HTTP connections are reduced to the message, never headers. A test asserts that the secret never appears in `error` or in log output.
- **[Risk] A slow server holds a request open for up to 10 seconds.** → The timeout is bounded, the busy state shows in the UI, and serialization is per server, so other servers are unaffected.
- **[Trade-off] Stdio env values are merged into the full `process.env`, as today.** A stdio server therefore also sees `FRIDAY_MASTER_KEY` and `GEMINI_API_KEY`. This is unchanged behaviour but more visible now that users define the commands. → Kept for compatibility (npx needs `PATH` and `HOME`); noted in the README.
- **[Trade-off] Names can't be renamed.** Renaming means deleting and re-creating the server, including re-entering its secrets. Acceptable given how rarely servers change.
- **[Risk] Upgrading drops MCP tools until the server is re-entered.** → See the migration plan. There's one server (`home`), and the portal is available straight after deploy.

## Migration Plan

1. Deploy the new image with the updated `deploy/k8s.yaml`, which no longer has the `mcp` volume or `FRIDAY_MCP_CONFIG`. Migration 5 creates the empty tables, and Friday starts with no MCP servers. Home Assistant tools are gone until step 2.
2. In `Settings > Configuration > MCP servers`, add `home` with the values from `mcp.json`: HTTP, its URL, header `Authorization` marked secret with the bearer token, scheduling `SILENT`. `FRIDAY_MASTER_KEY` is already set in the deployment.
3. Confirm `mcp:home` shows `loaded` on the Modules page.
4. Delete the `friday-mcp` Secret by hand, and delete the local `mcp.json`.

**Rollback:** the previous image ignores the new tables, since migrations are additive. It needs the `friday-mcp` Secret and the `FRIDAY_MCP_CONFIG` mount back, so delete the Secret only after the new version is confirmed working.

After archiving, update the Purpose of `openspec/specs/mcp-tools/spec.md`, which still mentions `mcp.json`, by hand.
