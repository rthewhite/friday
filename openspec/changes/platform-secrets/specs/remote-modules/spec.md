# Spec Delta

## MODIFIED Requirements

### Requirement: Keys are resolved through a key store

Core SHALL resolve keys through a `KeyStore` with `lookup(key) → id | undefined`. The default store SHALL first look up `sha256(key)` among non-revoked stored keys, updating `last_seen_at`, and then fall back to `FRIDAY_MODULE_KEYS` parsed as comma-separated `<id>=<key>` pairs. When neither source has any key, every hello SHALL be rejected with 4401 and a startup warning SHALL note that remote modules are disabled.

#### Scenario: Env keys
- **WHEN** `FRIDAY_MODULE_KEYS=simracing=abc,lab=def`
- **THEN** `lookup("def")` returns `lab`

#### Scenario: No keys configured
- **WHEN** `FRIDAY_MODULE_KEYS` is unset and no keys are stored
- **THEN** startup logs a warning and any hello is closed with 4401

#### Scenario: Stored key
- **WHEN** a key was created in the portal for `simracing`
- **THEN** `lookup` returns `simracing` and the key's last-seen time is updated

#### Scenario: Revoked key
- **WHEN** a stored key is revoked while its module is connected
- **THEN** the socket is closed with 4401 and later lookups return `undefined`

## ADDED Requirements

### Requirement: Key management API and page

`GET /api/keys` SHALL list keys without secrets; `POST /api/keys` with `moduleId` and `label` SHALL create a key and return the plaintext exactly once; `DELETE /api/keys/:id` SHALL revoke it. The portal SHALL provide `Settings > Remote modules` to create (showing the key once with a copy button), list with last-seen, and revoke keys.

#### Scenario: Create
- **WHEN** the user creates a key for `simracing`
- **THEN** the plaintext is shown once and subsequent listings show only metadata

#### Scenario: Revoke
- **WHEN** the user revokes a key
- **THEN** it is marked revoked and cannot authenticate
