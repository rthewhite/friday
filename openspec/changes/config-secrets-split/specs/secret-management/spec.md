# Spec Delta

## MODIFIED Requirements

### Requirement: Encrypted configuration store

Configuration values SHALL be stored per (scope, key) as either **secret** or **plain**. Secret values SHALL be stored encrypted with AES-256-GCM using the 32-byte base64 `FRIDAY_MASTER_KEY`, a random IV per value, and `scope:key` as additional authenticated data. Plain values SHALL be stored as plaintext and SHALL NOT depend on the master key. A key declared `secret: true` by any module SHALL always be stored secret; undeclared keys use the `secret` flag of the write request, defaulting to plain. When `FRIDAY_MASTER_KEY` is unset, secret writes SHALL fail with 503 and a message, secret reads SHALL fall back to the environment, and plain values SHALL keep working. A secret value that fails to decrypt SHALL be logged and treated as unset. Rows created before the split SHALL be treated as secret.

#### Scenario: Save and read a secret
- **WHEN** `JELLYFIN_API_KEY` (declared secret) is saved for scope `media`
- **THEN** the database row is ciphertext and `config.get` in media returns the plaintext

#### Scenario: Save and read a plain value
- **WHEN** `JELLYFIN_URL` (not declared secret) is saved for scope `media`
- **THEN** the database row holds the plaintext and `config.get` in media returns it

#### Scenario: No master key
- **WHEN** `FRIDAY_MASTER_KEY` is unset
- **THEN** `PUT /api/config/media/JELLYFIN_API_KEY` responds 503, `PUT /api/config/media/JELLYFIN_URL` responds 204, and the portal shows the banner on the Secrets tab only

#### Scenario: Wrong master key
- **WHEN** secret rows were encrypted with a different key
- **THEN** startup logs one error per row, those keys show as `pending`, and plain rows are unaffected

#### Scenario: Declared secret cannot be downgraded
- **WHEN** a PUT for a key some module declares `secret: true` carries `secret: false`
- **THEN** the value is still stored encrypted

### Requirement: Configuration API

`GET /api/config` SHALL return `{ secretsEnabled, entries }` listing every declared key per module plus global entries, each with `secret` (boolean) and `status` (`set`, `pending`, `env`). Plain entries with a stored or environment value SHALL include `value`; secret entries SHALL never include a value. `PUT /api/config/:scope/:key` with `{ value, secret? }` SHALL store a value; `DELETE` SHALL remove it. Scope SHALL be a loaded module id or `global`.

#### Scenario: Listing
- **WHEN** media declares `JELLYFIN_URL` (plain, stored) and `JELLYFIN_API_KEY` (secret, stored)
- **THEN** the URL entry has `secret: false` and its `value`; the key entry has `secret: true`, status `set`, and no `value`

#### Scenario: Env plain value is visible
- **WHEN** `HA_URL` is plain and comes from the environment
- **THEN** its entry has status `env` and includes the environment value

#### Scenario: Unknown scope
- **WHEN** a PUT targets scope `nope`
- **THEN** the response is 404

### Requirement: Configuration page

The portal SHALL provide `Settings > Configuration` with two tabs, `Configuration` and `Secrets`, both grouping entries by module. The Configuration tab SHALL show each plain value in an editable text field with Save and Clear actions. The Secrets tab SHALL show status badges and a masked field for setting or changing a value; saved secret values SHALL NOT be displayed afterwards. Both tabs SHALL offer a scope selector (module or global), a `Save and reload module` action, and a form to add an undeclared global value, stored as secret only from the Secrets tab. The active tab SHALL be reflected in the URL.

#### Scenario: Edit a plain value inline
- **WHEN** the user changes `JELLYFIN_URL` in the Configuration tab and saves
- **THEN** the new value is stored plain and remains visible in the field

#### Scenario: Fill in a pending secret
- **WHEN** the user enters a value for a `pending` secret and clicks `Save and reload module`
- **THEN** the key shows `set`, the value is not displayed, the module reloads, and the Modules page shows it `loaded`

#### Scenario: Deep link
- **WHEN** the user opens `/settings/config?tab=secrets`
- **THEN** the Secrets tab is active
