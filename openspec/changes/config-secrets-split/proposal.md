# Proposal

## Why

The configuration store treats every value as a secret: encrypted, hidden after saving, unusable without a master key. Most module configuration is not secret (URLs, entity ids, user names), and hiding it makes the portal awkward to verify and maintain. Jarvis kept a clear split between environment variables and secrets; Friday should too, without making modules retrieve them differently.

## What Changes

- A declared config key MAY be marked `secret: true` in the module manifest. Retrieval is unchanged: `ctx.config.get` and `require` work for both kinds.
- Plain (non-secret) values are stored as plaintext and returned by the API, so the portal can show and edit them inline. Plain configuration works even when `FRIDAY_MASTER_KEY` is unset.
- Secret values keep AES-256-GCM encryption, are never returned, and still need the master key.
- `Settings > Configuration` gets two tabs, Configuration and Secrets, both grouped by module. Plain values are visible and edited in a text field; secrets show status only and use a masked field. Global entries a user adds default to plain, with a checkbox to store them as a secret.
- The media module marks `JELLYFIN_API_KEY` and `HA_TOKEN` as secrets; the builtin module's timezone stays plain.
- Storage migration 2 adds the `secret` column; existing rows (all encrypted today) are kept as secrets so nothing is decrypted into plaintext without the user re-saving it.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities
- `secret-management`: the store distinguishes plain and secret values (encryption, master-key dependence, API exposure); the configuration page splits into two tabs.
- `module-system`: the manifest `config` entry gains `secret`.

## Impact

- Depends on `platform-secrets` (store, API, page). Small changes in `packages/sdk` (type), `packages/core` (migration, `ConfigStore`, `/api/config`), `packages/portal` (page), `modules/media` (manifest flags), tests and docs.
- No change to remote modules, keys, or the resolver order.
- Rows saved before this change stay secret. Users who want a URL visible re-save it in the Configuration tab.
