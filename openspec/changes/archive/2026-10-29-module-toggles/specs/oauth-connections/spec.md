# Spec Delta

## MODIFIED Requirements

### Requirement: Modules request access

The in-process modules' manifests SHALL be the source of requests: each `oauth` entry names a provider, the scopes the module needs and why. Core SHALL list, per provider, the modules requesting it with their scopes, description and whether they are granted, including providers that no connection exists for yet. A request SHALL NOT be stored and SHALL disappear when the module is no longer in core's list or is disabled. A disabled module's grants SHALL be kept, so its request comes back granted when it is enabled again. When a request for a provider without a connection carries an authorization and token URL, those URLs SHALL be offered as the defaults for creating the connection; the stored connection's URLs SHALL be the ones used.

#### Scenario: Request without a connection
- **WHEN** the `spotify` module requests `spotify` and no Spotify connection exists
- **THEN** the connections listing has a `spotify` entry with `configured: false` and `spotify` among its requesters, not granted

#### Scenario: Module removed
- **WHEN** a module requesting `github` is removed from core's list and no `github` connection exists
- **THEN** the listing has no `github` entry

#### Scenario: Module disabled
- **WHEN** the `spotify` module, granted on the `spotify` connection, is disabled
- **THEN** `spotify` is no longer among the connection's requesters, and when the module is enabled again it is listed as granted

#### Scenario: Generic defaults from a manifest
- **WHEN** a module requests provider `acme` with an authorization and token URL and the user opens it in the portal
- **THEN** the create form is filled in with both URLs
