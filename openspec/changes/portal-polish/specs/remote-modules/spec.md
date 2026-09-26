# Spec Delta

## MODIFIED Requirements

### Requirement: Key management API and page

`GET /api/keys` SHALL list keys without secrets; `POST /api/keys` with `moduleId` and `label` SHALL create a key and return the plaintext exactly once; `DELETE /api/keys/:id` SHALL revoke it. The portal SHALL provide `Settings > Remote modules` as a table of keys (status dot, module, label, created, last seen) with a `New key` header action that opens a drawer for module id and label and shows the created key once with a copy button, and a `Revoke` row action.

#### Scenario: Create
- **WHEN** the user creates a key for `simracing`
- **THEN** the plaintext is shown once in the drawer and subsequent listings show only metadata

#### Scenario: Revoke
- **WHEN** the user revokes a key
- **THEN** it is marked revoked and cannot authenticate
