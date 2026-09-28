# Tasks

## 1. Storage: migration and `McpServerStore`

- [x] 1.1 Add migration 5 `mcp-servers` to `packages/core/src/storage/db.ts` creating `mcp_servers` and `mcp_server_entries`. `mcp_server_entries` references `mcp_servers(name)` with `ON DELETE CASCADE` and has primary key `(server, kind, name)`. Verify with a test in `storage.test.ts` that a fresh database reaches version 5, and that deleting a server row removes its entry rows.
- [x] 1.2 Implement `parseServerInput(body, { creating })` and `McpInputError` in `packages/core/src/tools/mcp-store.ts`, covering every check in design D3: the name regex and name only on create; transport with `command`, or `url` as http(s); string arrays; the `scheduling` enum; env and header name rules; no duplicate entry names; dropping fields that belong to the other transport. Verify with table-driven unit tests in a new `mcp-store.test.ts`, one case per rule, including `home assistant` being rejected.
- [x] 1.3 Implement `McpServerStore(db, masterKey)` with `list`, `get`, `create`, `update`, `delete` and `resolve`, plus `McpStoreDisabled`. Use `encrypt`/`decrypt` from `secrets/crypto.ts` with scope `mcp:<server>` and key `<kind>:<name>`. Writes run in one transaction. `create` throws a duplicate error for an existing name. Verify in `mcp-store.test.ts` that the secret column holds ciphertext, that `list()` never includes a secret value, that `resolve()` returns the plaintext, and that a definition survives reopening the database.
- [x] 1.4 Implement the update merge rules from the D2 table: a secret without a value keeps its ciphertext or encrypts the stored plaintext; a secret without a value and nothing stored is a 400 error; a plain entry without a value is a 400 error; omitted entries are deleted; a new secret value without a master key throws `McpStoreDisabled` and leaves the stored definition unchanged. Verify with one test per table row in `mcp-store.test.ts`.
- [x] 1.5 Make `resolve()` fail with value-free errors naming the entry, for example `secret header "Authorization" cannot be decrypted` and `… requires FRIDAY_MASTER_KEY`. Verify with tests that use a different master key, that swap the ciphertext between two entries (AAD binding), and that use no master key. Each test asserts the thrown message never contains the secret.

## 2. `McpSource`: per-server lifecycle

- [x] 2.1 Build a test fixture helper in `packages/core/test/` that serves an SDK MCP `Server` over `StreamableHTTPServerTransport` on an ephemeral port. It should expose configurable tools, record request headers, and optionally hang on `listTools`. Verify it with a smoke test that a plain SDK `Client` can list its tools.
- [x] 2.2 Rewrite `McpSource` in `packages/core/src/tools/mcp.ts` to take `(registry, store, { timeoutMs, log })` and keep a per-server state map (`loaded`, `failed` with `error`, `disabled`). `load()` applies all stored servers in parallel. `servers()` returns `{ name, status, error?, tools }`. Drop the `mcp.json` reading, the `FRIDAY_MCP_CONFIG` lookup, and the file-format header comment, and describe the stored model instead. Replace the file-fixture tests in `mcp.test.ts` and verify:
  - an empty store registers nothing;
  - one unreachable server is `failed` while another is `loaded`;
  - a disabled server registers no tools;
  - the `Authorization` header resolved from a secret reaches the fixture;
  - the include, exclude, prefix and scheduling tests still pass.
- [x] 2.3 Implement `apply(name)`, serialized per server with a promise chain keyed by name. It removes the owner's tools, closes the old client, reloads the definition, connects if the server is enabled, and removes the state when the server has been deleted. Tools are registered only after `listTools` succeeds. Verify with tests that:
  - updating `home` leaves `fs`'s client and tools untouched;
  - two concurrent `apply("home")` calls end with exactly one client and no duplicate-name registry error;
  - deleting a server removes its tools and its entry in `servers()`.
- [x] 2.4 Add the `withTimeout` deadline around connect plus `listTools`. On timeout, close the client and record `timed out after <n>s`. Verify with the hanging fixture and `timeoutMs: 50` that the server is `failed` with the timeout error and `load()` resolves.
- [x] 2.5 Make sure errors recorded or logged for a server never contain header or env values. For HTTP errors, keep only the message. Verify with a test whose fixture rejects the request (401), asserting that neither the `error` nor the captured log output contains the token.
- [x] 2.6 Verify that a session snapshot is unaffected. Take `registry.declarations()`, run `apply` for an updated server, and assert the earlier snapshot is unchanged while a new `declarations()` call reflects the update.

## 3. API and startup

- [x] 3.1 Add `mcpStore` to `AppDeps` and wire `server.ts`: construct `McpServerStore(db, parseMasterKey(settings.masterKey))`, pass it to `McpSource`, and keep `await mcp.load()` after `host.load()`. Remove the `mcp.json` note from the `Dockerfile` comment. Verify that `pnpm typecheck` passes and that `pnpm --filter @friday/core start` with an empty data dir starts without MCP errors (stop the process afterwards).
- [x] 3.2 Add `GET /api/mcp/servers` (`{ secretsEnabled, servers }`, each server being its definition merged with state and `updatedAt`) and `POST /api/mcp/servers` (201 with the entry after the connection attempt) to `packages/core/src/app.ts`. Map `McpInputError` to 400, a duplicate name to 409 and `McpStoreDisabled` to 503. Verify with `app.test.ts` tests for 201 with `loaded` and tool names against the fixture, 400 for an invalid name or missing `url`, 409 for a duplicate, and 503 for a secret value without a master key.
- [x] 3.3 Add `PUT /api/mcp/servers/:name` (200), `DELETE /api/mcp/servers/:name` (204) and `POST /api/mcp/servers/:name/reconnect` (200; a no-op for disabled servers), with 404 for unknown names. Verify with tests that:
  - an edit without re-sending the secret keeps the token, which the fixture still receives;
  - a body containing `name` on PUT is ignored or rejected, so the name never changes;
  - delete removes the server from both listings;
  - reconnect turns a server that failed at startup into `loaded` once the fixture is up.
- [x] 3.4 Add a test that creates and updates servers with secret headers and env values, then asserts that no response body from `/api/mcp/servers` or `/api/modules` contains any secret value.
- [x] 3.5 Update `moduleListing` in `app.ts` so every stored server appears as `mcp:<name>` with status `loaded`, `failed` (with `error`) or `disabled`, and an empty `tools` array when not loaded. Verify with `app.test.ts` cases for failed and disabled servers.

## 4. Portal: MCP servers tab

- [x] 4.1 Add the `mcp` tab (label `MCP servers`, count = number of servers) to `packages/portal/src/pages/settings/ConfigurationPage.vue`. It renders a new `McpServersTab.vue` and makes the header action `New server` when active. `?tab=mcp&server=<name>` opens that server's drawer. Verify that `pnpm --filter @friday/portal build` succeeds and that `/settings/config?tab=mcp&server=home` opens the drawer in `pnpm dev`.
- [x] 4.2 Implement the table in `McpServersTab.vue`: status dot (`loaded`, `failed`, `disabled`), name, transport (`stdio` or `HTTP`), tool count and updated time, loaded from `GET /api/mcp/servers`. Verify in `pnpm dev` against a stored server that the row shows the right status and tool count.
- [x] 4.3 Implement the drawer form described in D7:
  - name, editable only when adding, and an enabled checkbox;
  - a transport `<select>` that switches between `command` plus an `args` textarea (one per line) and a `url` field;
  - an env or header row list with name, value, a secret checkbox and remove;
  - `include` and `exclude` textareas, a `scheduling` select and `prefix`.

  Verify that the portal build type-checks and that switching transport keeps the other fields' values in the form.
- [x] 4.4 Implement secret handling in the drawer. A stored secret shows as a password input with placeholder `•••••• stored, leave blank to keep` and is sent as `{ name, secret: true }` when blank. Without a master key, show the existing secrets banner and disable the secret checkbox on new rows. Verify in `pnpm dev` that saving `home` with a secret `Authorization` header and reopening shows it masked with no value (network tab shows no value), and that a restart without `FRIDAY_MASTER_KEY` shows the banner.
- [x] 4.5 Implement `Save` (busy state while waiting for the response), `Reconnect` (existing enabled servers), and a two-step `Delete` → `Confirm delete`. Show the server's `error` in the drawer when it has failed, and refresh the row from the response. Verify in `pnpm dev`: an unreachable URL shows `failed` with the error; adding `include` for one tool drops the tool count to 1 without re-entering the token; delete removes the row.
- [x] 4.6 Verify the Modules page (`ModulesPage.vue`) shows failed and disabled MCP servers with the right dot and kind `MCP server`, still with no reload action. Change it only if needed, and verify in `pnpm dev`.

## 5. Deploy and docs

- [x] 5.1 Remove the `FRIDAY_MCP_CONFIG` env var, the `mcp` volume mount, the `friday-mcp` Secret volume and its mention in the header comment from `deploy/k8s.yaml`. Verify with `kubectl apply --dry-run=client -f deploy/k8s.yaml` (or a YAML lint) and `grep -n mcp deploy/k8s.yaml` showing no leftovers.
- [x] 5.2 Rewrite the README MCP section: configure servers in `Settings > Configuration > MCP servers`, mark tokens as secret (requires `FRIDAY_MASTER_KEY`), and note the stdio trust caveats from the design's Risks (the portal can spawn commands; stdio servers inherit the process environment). Replace `mcp.json` in the architecture diagram, delete `mcp.example.json`, and drop `mcp.json` from `.gitignore` or keep it with a "legacy" comment. Verify that `grep -rn "mcp.json\|FRIDAY_MCP_CONFIG" --exclude-dir=node_modules --exclude-dir=openspec .` returns nothing outside the git-ignored local file.
- [x] 5.3 Update the project context in `openspec/config.yaml`, which says "MCP servers come from mcp.json via packages/core/src/tools/mcp.ts", to describe the stored servers and `/api/mcp/servers`. Verify that `openspec instructions proposal --change mcp-config-ui` no longer mentions `mcp.json`.

## 6. Integration and rollout

- [ ] 6.1 Run `pnpm typecheck` and `pnpm test` in the foreground and verify both pass.
- [ ] 6.2 Run `pnpm dev` locally against a scratch `FRIDAY_DATA_DIR` with `FRIDAY_MASTER_KEY` set. Add the Home Assistant server from the local `mcp.json` through the portal, and verify `mcp:home` shows `loaded` on the Modules page and a voice session in Talk can call a `home__*` tool. Stop the dev servers afterwards.
- [ ] 6.3 After deploying, follow the migration plan in design.md: re-enter `home` in the production portal and confirm it is `loaded`. Then, only once confirmed, delete the `friday-mcp` k8s Secret and the local `mcp.json`. Verify with `sudo -n kubectl get secret friday-mcp` returning NotFound.
- [ ] 6.4 When archiving, update the Purpose of `openspec/specs/mcp-tools/spec.md` so it no longer says servers are configured in `mcp.json`. Verify with `openspec show mcp-tools --type spec` after archiving.
