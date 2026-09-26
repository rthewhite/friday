# Proposal

## Why

Every credential Friday uses (Gemini key, Jellyfin, Home Assistant, remote module keys) is a hand-made Kubernetes Secret or env var, and enabling a module means editing cluster config and redeploying. Modules already declare the config they need; the portal should let the user fill it in, and remote modules should get individually issued API keys instead of one env string. This is the first platform service core delivers to modules, the pattern later ones (OAuth sessions) will follow.

## What Changes

- Core gains persistent storage: a SQLite database in `FRIDAY_DATA_DIR` using Node's built-in `node:sqlite`, backed by a PersistentVolumeClaim in k8s. Modules get `ctx.storage` (a per-module key-value namespace) so they can persist data without their own database.
- Secret management: values for module-declared config keys and global keys are stored encrypted with `FRIDAY_MASTER_KEY` (AES-256-GCM). `ctx.config.get` resolves stored values first, then env. The portal gets a `Settings > Configuration` page listing declared keys per module with set/pending status and the ability to set or clear them; values are never returned to the browser after saving.
- Module reload: `POST /api/modules/:id/reload` disposes and re-initializes an in-process module, so a module that failed on missing config can be fixed from the portal without a restart. The Modules page gets a `Reload` button.
- Remote module API keys: `Settings > Remote modules` lets the user create a key for a module id (shown once), list keys with last-seen time, and revoke them. The remote-modules `KeyStore` resolves stored keys (hashed) first and falls back to `FRIDAY_MODULE_KEYS`.
- k8s: add the PVC and `FRIDAY_MASTER_KEY` to the secret; document that `friday-secrets` may shrink to the master key and Gemini key.

## Capabilities

### New Capabilities
- `platform-storage`: the core SQLite database, data directory, migrations, and the per-module `ctx.storage` namespace.
- `secret-management`: encrypted storage of configuration values, resolution order, the configuration API and portal page, and module reload.

### Modified Capabilities
- `remote-modules`: the key store resolves portal-issued keys and records last-seen; key management API and page.
- `module-system`: `ModuleContext` gains `storage`; `config.get` gains the stored-first resolution; the host supports reloading a single module.
- `portal-shell`: adds the `Settings` section with the two platform pages and a `Reload` action on the Modules page.

## Impact

- Depends on `modular-core`, `remote-modules` and `portal-shell`.
- New code in `packages/core` (storage, crypto, config resolver, keys API), `packages/sdk` (context types), `packages/portal` (Settings pages), `deploy/k8s.yaml` (PVC, env), `infra/README.md`.
- Runtime: SQLite file in a PVC; a lost `FRIDAY_MASTER_KEY` makes stored secrets unrecoverable, which is documented with a re-enter procedure.
- No new npm runtime dependency; `node:sqlite` requires Node 24, which the image already uses.
