# Spec Delta

## MODIFIED Requirements

### Requirement: Configuration API

`GET /api/config` SHALL return `{ secretsEnabled, entries }` with one entry per key: `key`, `secret`, `required` (true when any requester requires it), `description`, `modules` (array of `{ id, required }` of the requesters declaring the key, which are `core` and the modules that are not disabled; empty for undeclared globals), `status` (`set`, `pending`, `env`), `scope`, `updatedAt` for stored values, and `value` for plain entries with a stored or environment value. A key declared only by disabled modules SHALL be listed only when it is stored in some scope, and then as an undeclared key with empty `modules`. Whether a key is secret SHALL take every module in core's list into account, disabled ones included. When the key is stored in at least one scope, the entry SHALL also include `stored`: one item per stored scope with `scope`, `updatedAt`, and `value` for plain values, ordered `global`, then `core`, then other scopes by name; `stored` SHALL include scopes that no loaded module declares. Secret entries SHALL never include a value, in `value` or in `stored`. `PUT /api/config/:scope/:key` with `{ value, secret? }` SHALL store a value; `DELETE` SHALL remove it. Scope SHALL be a module in core's list (enabled or not), `core`, or `global` for `PUT`; `DELETE` SHALL accept any scope that holds the key, so a value left behind by a removed module can be cleared.

`PUT /api/config/:scope/:key` with `{ from }` instead of `value` SHALL copy the value the key has stored in scope `from` (any scope that holds the key) into `:scope`, without the value passing through the request or the response. The copy SHALL be stored secret when the source is secret or any requester declares the key secret, and plain otherwise. A body with both `value` and `from`, or neither, SHALL be refused with 400. A `from` scope that holds no value for the key SHALL be refused with 404. A source that is a secret which cannot be read (no master key, or it fails to decrypt) SHALL be refused with 503 and a message, and nothing SHALL be stored. A copy SHALL count as a write to `:scope` for everything that reacts to configuration changes.

#### Scenario: Listing
- **WHEN** media declares `JELLYFIN_URL` (plain, stored) and `JELLYFIN_API_KEY` (secret, stored)
- **THEN** the URL entry has `secret: false`, `modules: [{ id: "media", required: true }]`, its `value` and `updatedAt`; the key entry has `secret: true`, status `set`, and no `value`

#### Scenario: Shared key appears once
- **WHEN** two modules declare `HA_URL`
- **THEN** the listing has one `HA_URL` entry whose `modules` lists both

#### Scenario: Key of a disabled module
- **WHEN** only `travel` declares `TOMTOM_API_KEY`, `travel` is disabled, and the key is stored nowhere
- **THEN** the listing has no `TOMTOM_API_KEY` entry, and enabling `travel` brings it back

#### Scenario: Stored key of a disabled module
- **WHEN** `travel` is disabled and `TOMTOM_API_KEY` is stored for `travel`
- **THEN** the key is listed with empty `modules`, `secret: true`, no `value`, and `stored` naming `travel`

#### Scenario: Shared key with a disabled module
- **WHEN** `media` and `sonos` declare `HA_URL` and `sonos` is disabled
- **THEN** the `HA_URL` entry's `modules` lists only `media`

#### Scenario: Env plain value is visible
- **WHEN** `HA_URL` is plain and comes from the environment
- **THEN** its entry has status `env` and includes the environment value, and has no `stored`

#### Scenario: Core's key is listed
- **WHEN** the configuration is listed
- **THEN** `GEMINI_API_KEY` appears with `secret: true`, `modules: [{ id: "core", required: true }]`, and no `value`

#### Scenario: Store for core
- **WHEN** a PUT targets scope `core` for `GEMINI_API_KEY`
- **THEN** the value is stored encrypted and the listing reports status `set` with scope `core`

#### Scenario: Unknown scope
- **WHEN** a PUT targets scope `nope`
- **THEN** the response is 404

#### Scenario: Every stored scope is listed
- **WHEN** `FRIDAY_TIMEZONE` is stored globally as `Europe/Amsterdam` and for `builtin` as `Asia/Tokyo`
- **THEN** its entry has `stored` with `global` (value `Europe/Amsterdam`) first and `builtin` (value `Asia/Tokyo`) second, each with `updatedAt`

#### Scenario: Secret values stay hidden in stored
- **WHEN** `HA_TOKEN` (secret) is stored for `media` and globally
- **THEN** its `stored` items have `scope` and `updatedAt` but no `value`

#### Scenario: Copy a secret to another module
- **WHEN** `HA_TOKEN` (declared secret) is stored for `media` and a PUT targets scope `sonos` with `{ from: "media" }`
- **THEN** the response is 204 and contains no value, `sonos` reads the same token as `media`, `stored` lists `media` and `sonos`, and the `sonos` copy is stored encrypted

#### Scenario: Copy a plain value
- **WHEN** `HA_URL` (plain) is stored for `media` and a PUT targets scope `sonos` with `{ from: "media" }`
- **THEN** `sonos` reads the same URL, stored plain

#### Scenario: Copy from a scope without the key
- **WHEN** a PUT targets scope `sonos` for `HA_TOKEN` with `{ from: "brain" }` and `brain` stores no `HA_TOKEN`
- **THEN** the response is 404 and nothing is stored

#### Scenario: Value and from together
- **WHEN** a PUT body has both `value` and `from`
- **THEN** the response is 400 and nothing is stored

#### Scenario: Unreadable secret source
- **WHEN** `HA_TOKEN` is stored for `media` but fails to decrypt, and a PUT targets `sonos` with `{ from: "media" }`
- **THEN** the response is 503 with a message and `sonos` stores nothing

### Requirement: Module reload

`POST /api/modules/:id/reload` SHALL dispose the in-process module if loaded, remove its tools and routes, and initialize it again with current configuration, returning its new module entry. A disabled module SHALL respond 409 with an error saying it is disabled, and SHALL stay disabled. Remote modules and unknown ids SHALL respond 404.

#### Scenario: Fix a failed module
- **WHEN** media failed on a missing required key, the key is saved, and reload is called
- **THEN** media reports `loaded` and its tools are registered

#### Scenario: Reload during a session
- **WHEN** a reload happens while a voice session is open
- **THEN** the session keeps its tool snapshot and the next session sees the reloaded tools

#### Scenario: Reload a disabled module
- **WHEN** reload is called for `sonos` while it is disabled
- **THEN** the response is 409, `sonos` is not initialized, and it still reports `disabled`
