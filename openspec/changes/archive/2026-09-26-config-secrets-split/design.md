# Design

## Context

`config_values` stores `(scope, key, ciphertext, iv, tag)` and `ConfigStore` encrypts everything with the master key; `/api/config` never returns values; the portal has one list with masked entry. The `ConfigKey` type is `{ key, required?, description? }`. See `platform-secrets` for the rest.

## Goals / Non-Goals

**Goals:**
- One resolver and one retrieval API for modules; the split is a declaration, not a code path.
- Plain values readable and editable in the portal; secrets write-only.
- Plain configuration independent of the master key.

**Non-Goals:**
- Separate `ctx.secrets` API (rejected: forces every module to know the split twice, as in Jarvis).
- Per-value audit log or history.
- Changing key resolution order or global scope semantics.

## Decisions

### D1. `secret` is a manifest flag, storage decides the rest

`ConfigKey.secret?: boolean`. The host passes the declared flags to the store through the API layer: `PUT /api/config/:scope/:key` looks up the declared key across all modules; if any module declares it secret, the row is stored secret. An undeclared key (global extras) uses the request body's `secret` boolean, default `false`. Alternative considered: a per-request flag only. Rejected: the module author knows best, and the UI should not be able to downgrade a declared secret to plaintext.

### D2. Storage

Migration 2: `ALTER TABLE config_values ADD COLUMN secret INTEGER NOT NULL DEFAULT 1; ALTER TABLE config_values ADD COLUMN plaintext TEXT;`. Secret rows use `ciphertext/iv/tag` as today; plain rows use `plaintext` with empty blobs in the crypto columns. Existing rows default to `secret = 1`, so nothing previously saved becomes readable without a deliberate re-save. `ConfigStore.get` reads whichever column applies; `set(scope, key, value, { secret })` writes the matching shape. `verifyAll` only touches secret rows.

### D3. Master key only gates secrets

`ConfigStoreDisabled` is thrown only for secret writes. `enabled` becomes `secretsEnabled`; the API reports `{ secretsEnabled }` and the page shows the banner only on the Secrets tab. Plain values are always writable.

### D4. API shape

`GET /api/config` entries gain `secret: boolean` and, for plain entries with a stored value, `value: string`. `env`-sourced plain values also include `value` so the user can see what the environment provides; `env`-sourced secrets do not. `PUT` body: `{ value, secret? }`; `secret` is ignored for declared keys.

### D5. Portal

Same page, two tabs (`?tab=config|secrets` in the URL so links work). Configuration tab: each entry shows its current value in a text field with Save and Clear; editing is inline, no separate form. Secrets tab: current behaviour (status badge, masked field shown on Set/Change). Both tabs group by module and keep the scope selector and `Save and reload module`. A "Add global value" form at the bottom of each tab creates undeclared globals; on the Secrets tab it stores them as secret.

## Risks / Trade-offs

- [Plaintext in the database file] → Only for values the module declared non-secret; the file lives on the cluster PVC as before. Documented in the infra README.
- [A module forgets `secret: true` on a token] → Reviewer responsibility; the media module is the reference. The portal shows plain values, which makes a missing flag visible immediately rather than silently.
- [Migration on a live database] → Two `ALTER TABLE ADD COLUMN` statements, safe in SQLite and covered by the migration runner's transaction.

## Open Questions

None.
