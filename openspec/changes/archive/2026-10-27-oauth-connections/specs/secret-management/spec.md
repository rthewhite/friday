# Spec Delta

## MODIFIED Requirements

### Requirement: Core declares its own configuration

Core SHALL declare its own configuration keys as the requester `core`, in the same shape as a module's `config` entries. It SHALL declare `GEMINI_API_KEY` as secret and required, `FRIDAY_TIMEZONE` as plain and optional (the zone for cron schedules), and `FRIDAY_PUBLIC_URL` as plain and optional (the base URL OAuth redirect URIs are built from, as specified in `oauth-connections`). Core SHALL resolve its keys from the `core` scope, then the `global` scope, then the process environment, and SHALL read them at each use, so a stored value applies to the next voice session, the next text-generation call, the next authorization and, for `FRIDAY_TIMEZONE`, the cron schedules without a restart. A missing required core key SHALL NOT stop core from starting: startup SHALL log a warning naming the key, and features that need it SHALL fail as they do today without a key. `FRIDAY_MASTER_KEY` SHALL be read from the environment only.

#### Scenario: Key saved in the portal
- **WHEN** `GEMINI_API_KEY` is only in the environment and the user saves a different value for scope `core`
- **THEN** the next voice session and the next `ctx.llm` call use the saved value, without a restart

#### Scenario: Environment fallback
- **WHEN** no `GEMINI_API_KEY` is stored in scope `core` or `global`
- **THEN** core uses the environment value, and the configuration listing reports status `env`

#### Scenario: No key anywhere
- **WHEN** `GEMINI_API_KEY` is neither stored nor in the environment
- **THEN** core starts, logs a warning naming `GEMINI_API_KEY`, and the listing reports it `pending`

#### Scenario: Core key in the drawer
- **WHEN** the user opens `GEMINI_API_KEY` on the Secrets tab
- **THEN** the scope selector offers `core` and `global`, the drawer offers `Save` and `Clear` but no reload action, and states that the value applies to the next session

#### Scenario: Core-only time zone in the drawer
- **WHEN** the user opens `FRIDAY_TIMEZONE` and selects scope `core`
- **THEN** the drawer states that the value re-plans cron jobs at once and is not seen by modules unless saved as global

#### Scenario: Core lists the time zone among its keys
- **WHEN** the configuration listing is requested
- **THEN** the `FRIDAY_TIMEZONE` entry is plain, not required, and lists `core` among its requesters together with the modules that declare it

#### Scenario: Public URL saved in the portal
- **WHEN** the user saves `FRIDAY_PUBLIC_URL` as `https://friday.thewhite.nl` for scope `core`
- **THEN** the next connections listing and the next authorization use redirect URIs under `https://friday.thewhite.nl`, without a restart
