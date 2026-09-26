# Tasks

## 1. Storage foundation

- [x] 1.1 Implement `storage/db.ts` opening `FRIDAY_DATA_DIR/friday.db` with `node:sqlite`, a migration runner with `schema_version`, and migration 001 creating `config_values`, `module_keys`, `module_kv`; verify tests for fresh start, incremental upgrade, and failing migration abort
- [x] 1.2 Implement `ctx.storage` (get/set/delete/list, JSON values, module namespace) and the in-memory version in `createTestHost`; verify isolation and round-trip tests in both
- [x] 1.3 Add the PVC and `FRIDAY_DATA_DIR=/data` to `deploy/k8s.yaml` and a `data/` entry to `.gitignore` and `.dockerignore`; verify `kubectl apply --dry-run=client` passes and the image creates `/data/friday.db` when the volume is mounted

## 2. Encrypted configuration

- [x] 2.1 Implement `crypto.ts` (AES-256-GCM with AAD, master key parsing) and `ConfigStore` (set/get/delete/list by scope, disabled mode when the key is unset, per-row decrypt failure handling); verify tests for round-trip, tamper detection, wrong key, and disabled mode
- [x] 2.2 Wire `ctx.config` to the resolver (module scope → global → env, lazy, cache invalidated on write) and report `status` per declared key; verify tests for each resolution order case and the `env` status
- [x] 2.3 Add `GET /api/config`, `PUT/DELETE /api/config/:scope/:key` with scope validation and 503 when disabled; verify route tests including unknown scope 404 and that responses never include values

## 3. Module reload

- [x] 3.1 Implement `ModuleHost.reload(id)` (dispose, removeOwner, drop routes, validate, init) and `POST /api/modules/:id/reload`; verify tests for failed→loaded, reload failure keeps `failed`, and 404 for remote or unknown ids
- [x] 3.2 Audit `modules/media` so all config reads happen at call time, not in `init`; verify a test saves a key after init and the next tool call uses it

## 4. Remote module keys

- [x] 4.1 Implement `SqliteKeyStore` (sha256 lookup, last-seen update, revoke) and `CompositeKeyStore` over SQLite then env; verify tests for stored, env fallback, revoked, and the "no keys anywhere" warning
- [x] 4.2 Add `GET/POST /api/keys` and `DELETE /api/keys/:id`, returning plaintext only on create, and close connected sockets with 4401 on revoke; verify tests for create-once semantics and live revocation
- [x] 4.3 Update `.env.example`, `infra/README.md` and `remote/simracing/README.md` to prefer portal-issued keys with env as fallback; verify the documented flow works end to end

## 5. Portal pages

- [x] 5.1 Add the `Settings` nav group and routes `/settings/config`, `/settings/keys`; verify navigation renders and highlights
- [x] 5.2 Build `ConfigurationPage.vue` (grouped by module, status badges, set/clear form, scope selector, `Save and reload module`, disabled-store banner); verify manually that filling a pending key and saving turns the media module `loaded`
- [x] 5.3 Build `RemoteModulesPage.vue` (create with module id and label, one-time key display with copy, list with last-seen, revoke); verify manually by connecting the simracing skeleton with a portal-issued key and revoking it
- [x] 5.4 Add the `Reload` button to the Modules page for in-process modules; verify it refreshes the entry after reload

## 6. Deploy and docs

- [x] 6.1 Add `FRIDAY_MASTER_KEY` generation and storage instructions to `infra/README.md` including the lost-key procedure and a `sqlite3 .backup` note; verify by following the doc on a fresh namespace
- [x] 6.2 Update `README.md` (configuration via portal, reload, keys) and `openspec/config.yaml` context (storage, secrets); verify `openspec validate --all` passes

## 7. Integration check

- [ ] 7.1 Deploy with an empty `friday-secrets` except Gemini and master keys, set all media config from the portal, reload media, run a voice turn using a media tool, issue a remote key, connect simracing, revoke the key and confirm disconnect; verify each step through the portal and logs
