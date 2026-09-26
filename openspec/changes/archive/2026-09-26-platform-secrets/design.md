# Design

## Context

After the three preceding changes, core has: a module host with declared config keys read from `process.env`, a `KeyStore` interface for remote modules backed by `FRIDAY_MODULE_KEYS`, a path router with module-scoped routes, and a Vue portal with a `Modules` page. Nothing persists between restarts; all secrets come from the k8s Secret.

Jarvis solved this with a separate `config` service that every module polls at startup, retrying forever, and then copies secrets into `process.env`. We want the same user-facing result (pending keys visible in the portal, fill them in, module works) without a second service or a boot dependency.

## Goals / Non-Goals

**Goals:**
- One durable store owned by core, exposed to modules as a narrow API.
- Secrets encrypted at rest, never sent back to the browser, resolved lazily so a module picks up new values on reload.
- Remote module keys issued and revoked from the portal, hashed at rest.
- Keep env-based configuration working so nothing breaks on upgrade.

**Non-Goals:**
- OAuth flows and token refresh (future change; will reuse `platform-storage` and the Settings section).
- Portal authentication or per-user secrets. Single-user, LAN-only.
- Backups beyond "the PVC"; a `sqlite3 .backup` note in the infra README suffices.
- Exposing storage to remote modules.

## Decisions

### D1. `node:sqlite`, one file, core-owned migrations

`FRIDAY_DATA_DIR` (default `./data` in dev, `/data` in the image) holds `friday.db`. Core runs numbered migrations at boot (`storage/migrations/*.sql`, tracked in a `schema_version` table). Tables: `config_values(scope, key, ciphertext, iv, tag, updated_at)`, `module_keys(id, module_id, key_hash, label, created_at, last_seen_at, revoked_at)`, `module_kv(module_id, key, value_json, updated_at)`. Why `node:sqlite`: no native build step in the Alpine image, synchronous API fits a small server. Alternative: `better-sqlite3` (native compile), or JSON files (no transactions, awkward for keys). Rejected.

### D2. Encryption and key handling

`FRIDAY_MASTER_KEY` is a 32-byte base64 value. Values are encrypted with AES-256-GCM, random 12-byte IV, AAD = `scope:key`. If the master key is unset, the config store is disabled: the portal shows a banner explaining how to set it and `config.get` falls back to env only. If the key does not decrypt existing rows, core logs an error per row and treats them as unset rather than crashing. Remote module keys are random 32 bytes, base64url, shown once; only `sha256(key)` is stored. Alternative: store secrets unencrypted in the PVC because the cluster is private. Rejected: a one-file exfil would leak everything, and the cost of GCM is a few lines.

### D3. Resolution order and scopes

```
ctx.config.get(KEY)  ->  config_values[scope=<module id>][KEY]
                     ->  config_values[scope="global"][KEY]
                     ->  process.env[KEY]
                     ->  undefined
```

Reads are lazy and uncached beyond a per-boot in-memory map that is invalidated on write, so a reload sees new values. Module-scoped values let two modules use the same key name with different values; the portal writes module scope by default and offers global for keys shared across modules (e.g. `HA_URL`).

### D4. Module reload

`ModuleHost.reload(id)`: `dispose()` if loaded, `removeOwner(id)`, drop routes, re-run required-key validation and `init`. In-flight tool calls finish against the old handler closure. Exposed as `POST /api/modules/:id/reload` and a button on the Modules page. The Configuration page offers "Save and reload module" as the primary action so the common flow is one click. Only in-process modules are reloadable; remote ones re-register themselves.

### D5. Key store

`SqliteKeyStore.lookup(key)`: hash, find non-revoked row, update `last_seen_at`, return `module_id`. `CompositeKeyStore` tries SQLite then env, so existing deployments keep working and the env variable can be dropped later. Revocation closes any connected socket for that key with `4401` immediately.

### D6. API surface (core, under the path router)

```
GET    /api/config                      -> [{ module, key, required, description, status: set|pending|env, scope }]
PUT    /api/config/:scope/:key          { value }           -> 204
DELETE /api/config/:scope/:key                              -> 204
POST   /api/modules/:id/reload                              -> module entry
GET    /api/keys                        -> [{ id, moduleId, label, createdAt, lastSeenAt, revoked }]
POST   /api/keys                        { moduleId, label } -> { id, key }   (key only here)
DELETE /api/keys/:id                                        -> 204
```

`status: env` tells the user a value comes from the environment and cannot be cleared from the portal.

### D7. `ctx.storage` for modules

`ctx.storage.get(key)`, `set(key, value)`, `delete(key)`, `list(prefix?)` over `module_kv`, values JSON-serialized, namespace = module id. Deliberately tiny; a module needing tables can ask for a dedicated change. Not offered to remote modules (they have their own machine).

## Risks / Trade-offs

- [Lost master key] → All stored config becomes unreadable. Documented: generate the key once, store it in the k8s Secret and a password manager; the portal's pending list makes re-entry straightforward.
- [Single replica and SQLite] → Already a constraint (Recreate strategy). Fine.
- [Secrets in memory] → Values are read on demand and not copied into `process.env`, unlike Jarvis; tool handlers should read `ctx.config` lazily rather than at init.
- [Portal has no auth] → Anyone on the LAN can set config and mint keys. Same posture as the rest of the portal; forward-auth is a separate future change and is called out in the README.

## Open Questions

None blocking.
