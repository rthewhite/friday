# Spec Delta

## MODIFIED Requirements

### Requirement: API access depends on the session and the role

Every request to `/api/` SHALL be answered with 401 and `{ "error": "unauthenticated" }` when it has no session. A disabled user's requests SHALL be answered the same way. The following SHALL be admin-only and SHALL answer 403 with `{ "error": "forbidden" }` to a member:
- `/api/config` and everything under it, `/api/mcp/`, `/api/keys`, `/api/devices`, `/api/oauth/`, `/api/jobs`, `/api/alerts`, `/api/users` and everything under them;
- `POST /api/modules/:id/reload`;
- `PUT /api/modules/:id/enabled`.

All other `/api/` requests SHALL be open to every user, including `GET /api/modules` and module routes under `/api/modules/<id>/`. The check SHALL apply to every route under these prefixes, including routes added later. `/health`, `/auth/` routes and static files SHALL need no session. Voice device and remote module connections SHALL keep their own authentication as specified in `audio-transport` and `remote-modules`.

#### Scenario: No session
- **WHEN** a request to `GET /api/conversations` carries no session cookie
- **THEN** the response is 401

#### Scenario: Member reads settings
- **WHEN** a member requests `GET /api/config`
- **THEN** the response is 403

#### Scenario: Member chats
- **WHEN** a member posts to `/api/chat`
- **THEN** the turn runs

#### Scenario: Admin adds an MCP server
- **WHEN** an admin posts a server to `/api/mcp/servers`
- **THEN** the request is handled normally

#### Scenario: Module route
- **WHEN** a member requests `GET /api/modules/brain/pages`
- **THEN** the brain's handler runs with that member as `req.user`

#### Scenario: Member switches a module off
- **WHEN** a member sends `PUT /api/modules/sonos/enabled` with `{ "enabled": false }`
- **THEN** the response is 403 and `sonos` stays as it was

#### Scenario: Member lists the modules
- **WHEN** a member requests `GET /api/modules`
- **THEN** the listing is returned, so the sidebar can show the module pages

#### Scenario: Health stays open
- **WHEN** the kubelet requests `/health` without a cookie
- **THEN** the response is 200
