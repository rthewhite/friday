# User Auth

## Purpose

Makes every browser request to Friday belong to a known user. Users log in through the household's OpenID Connect provider (Authentik), are provisioned on first login, and get a role. They form the basis for per-user data later.

## Requirements

### Requirement: Authentication is configured through the environment

Core SHALL read its OpenID Connect settings from `FRIDAY_AUTH_ISSUER` (the provider's issuer URL), `FRIDAY_AUTH_CLIENT_ID` and `FRIDAY_AUTH_CLIENT_SECRET`, and the group names from `FRIDAY_AUTH_USER_GROUP` (default `friday-users`) and `FRIDAY_AUTH_ADMIN_GROUP` (default `friday-admins`). Authentication SHALL count as configured when `FRIDAY_AUTH_ISSUER` is set. When it is configured, core SHALL refuse to start, with an error naming the missing key, when `FRIDAY_AUTH_CLIENT_ID`, `FRIDAY_AUTH_CLIENT_SECRET` or `FRIDAY_MASTER_KEY` is missing. The redirect URI SHALL be `<FRIDAY_PUBLIC_URL>/auth/callback`, without a doubled slash. When authentication is configured and `FRIDAY_PUBLIC_URL` is unset, core SHALL refuse to start.

#### Scenario: Complete configuration
- **WHEN** the issuer, client id, client secret, master key and `FRIDAY_PUBLIC_URL=https://friday.thewhite.nl` are set
- **THEN** core starts with authentication enabled and uses `https://friday.thewhite.nl/auth/callback` as redirect URI

#### Scenario: Missing client secret
- **WHEN** `FRIDAY_AUTH_ISSUER` is set and `FRIDAY_AUTH_CLIENT_SECRET` is not
- **THEN** core exits at startup with an error naming `FRIDAY_AUTH_CLIENT_SECRET`

#### Scenario: Missing master key
- **WHEN** authentication is configured and `FRIDAY_MASTER_KEY` is not set
- **THEN** core exits at startup with an error naming `FRIDAY_MASTER_KEY`

### Requirement: Without configured authentication only the local machine gets in

When authentication is not configured, core SHALL treat a request or WebSocket upgrade whose peer address is a loopback address (`127.0.0.1`, any `127.0.0.0/8` address, `::1`, or an IPv4-mapped loopback) and whose `Host` header names the local machine (`localhost`, `127.0.0.1` or `[::1]`, any port) as made by a fixed dev user with id `dev`, name `Dev` and role `admin`, created on first use like any user. Requests from any other address SHALL be treated as having no session. Forwarded headers SHALL NOT be used to decide this. Core SHALL log a warning at startup that authentication is off and only the local machine has access. When authentication is not configured and `FRIDAY_PUBLIC_URL` is set to anything other than an `http://localhost` or `http://127.0.0.1` URL (any port and path), core SHALL refuse to start.

#### Scenario: Local development
- **WHEN** authentication is not configured and the Vite dev server proxies `GET /api/conversations` from `127.0.0.1`
- **THEN** the request is handled as user `dev` with role `admin`

#### Scenario: Another machine on the LAN
- **WHEN** authentication is not configured and `192.168.1.40` requests `GET /api/conversations`
- **THEN** the response is 401

#### Scenario: Reverse proxy on the same machine
- **WHEN** authentication is not configured and a reverse proxy on the same machine forwards a request for `friday.example` from `127.0.0.1`
- **THEN** the response is 401

#### Scenario: Forged forwarding header
- **WHEN** authentication is not configured and `192.168.1.40` sends `X-Forwarded-For: 127.0.0.1`
- **THEN** the response is 401

#### Scenario: Deployed without authentication
- **WHEN** authentication is not configured and `FRIDAY_PUBLIC_URL=https://friday.thewhite.nl`
- **THEN** core exits at startup with an error saying authentication must be configured

### Requirement: Users log in with the provider's authorization-code flow

`GET /auth/login` SHALL redirect to the provider's authorization endpoint with the authorization-code flow, PKCE (`S256`), a random `state` and `nonce`, and the scopes `openid email profile offline_access`. It SHALL keep the state, the PKCE verifier, the nonce and the return path in a short-lived (10 minutes), `HttpOnly` cookie. The return path SHALL be the `return_to` query parameter when it is a path on Friday itself (it starts with `/` and not with `//` or `/\`), and `/` otherwise. `GET /auth/callback` SHALL require a `state` matching that cookie, exchange the code, and accept the ID token only when its issuer, audience, expiry and nonce match. On success it SHALL provision the user (see "Users are provisioned on first login"), start a session and redirect to the return path. Any failure SHALL answer with an error page, start no session and clear the login cookie. A provider error such as `access_denied` SHALL be shown on that page. Authentication routes SHALL respond 404 when authentication is not configured.

#### Scenario: Login and back
- **WHEN** a user opens `/auth/login?return_to=/chat/abc`, logs in at the provider and is sent back to `/auth/callback`
- **THEN** a session cookie is set and the browser is redirected to `/chat/abc`

#### Scenario: Open redirect refused
- **WHEN** a user opens `/auth/login?return_to=//evil.example/`
- **THEN** after logging in the browser is redirected to `/`

#### Scenario: State mismatch
- **WHEN** `/auth/callback` is called with a `state` that doesn't match the login cookie
- **THEN** an error page is shown and no session is started

#### Scenario: Wrong nonce
- **WHEN** the ID token's nonce differs from the one stored at login
- **THEN** an error page is shown and no session is started

### Requirement: Only members of Friday's groups get in

A login SHALL succeed only when the `groups` claim contains the user group or the admin group. Otherwise core SHALL answer the callback with a 403 page saying the account has no access to Friday, with a link to log out at the provider, SHALL start no session, SHALL NOT create a user, and SHALL log the subject and the groups received. A missing `groups` claim SHALL count as no groups.

#### Scenario: Not in a Friday group
- **WHEN** a person whose groups are `["family"]` completes the login
- **THEN** they see the no-access page, no session is started and no user is created

#### Scenario: Member group
- **WHEN** a person whose groups include `friday-users` completes the login
- **THEN** a session is started

### Requirement: Users are provisioned on first login

Core SHALL store each user in `friday.db` with an id, the issuer and subject (`sub`) they log in with, an email, a display name, a role, a disabled flag, and the times of their first and last login. A user SHALL be identified by issuer and subject, never by email. On a successful login for an unknown issuer and subject, core SHALL create the user. On a login for a known user, it SHALL update the email, the display name (`name`, else `preferred_username`, else the email), the role and the last login time. When the subject is unknown but a different user already has the same email, the login SHALL be refused with the no-access page, and the conflict SHALL be logged with both subjects. No user SHALL be created in that case.

#### Scenario: First login
- **WHEN** a member of `friday-users` logs in for the first time
- **THEN** a user is created with role `member`, their email and name, and first and last login set to now

#### Scenario: Name changed in the provider
- **WHEN** a known user logs in with a new `name` claim
- **THEN** their display name is updated and no new user is created

#### Scenario: Subject changed for the same email
- **WHEN** a login arrives with an unknown `sub` and an email that belongs to an existing user
- **THEN** the login is refused, the conflict is logged, and no user is created

### Requirement: Roles follow the provider's groups

A user SHALL have role `admin` when their `groups` claim contains the admin group, and role `member` otherwise. The role SHALL be set from the claims at every login and at every claim refresh of a session.

#### Scenario: Promoted
- **WHEN** a member is added to `friday-admins` and their session's claims are refreshed
- **THEN** their role is `admin` from that request on

#### Scenario: Demoted
- **WHEN** an admin is removed from `friday-admins` but stays in `friday-users`, and logs in again
- **THEN** their role is `member`

### Requirement: Sessions are kept by Friday

A successful login SHALL start a session identified by a random token of at least 256 bits. Core SHALL store only the token's SHA-256 hash, the user, the provider's refresh token encrypted with `FRIDAY_MASTER_KEY`, and the times it was created, last used and last refreshed. The cookie SHALL be named `__Host-friday_session` with `Secure`, `HttpOnly`, `SameSite=Lax` and `Path=/`. When the public URL is plain `http`, it SHALL be named `friday_session`, without `Secure`.
- A session SHALL end when it has not been used for 30 days.
- When a session's claims were last refreshed more than 24 hours ago, the next request SHALL first refresh them with the refresh token. Core SHALL update the user from the new claims, applying the group rule.
- When the provider refuses the refresh, or the user is no longer in a Friday group, the session SHALL end and the request SHALL be answered as having no session.
- When the provider can't be reached, the session SHALL be kept and refreshing SHALL be retried on a later request.
- A request with an unknown, ended or malformed session cookie SHALL be answered as having no session.

#### Scenario: Idle session
- **WHEN** a session was last used 31 days ago
- **THEN** the next request with its cookie is answered as having no session

#### Scenario: Removed in the provider
- **WHEN** a user's session is 25 hours past its last refresh and the provider refuses the refresh token
- **THEN** the session ends and the request gets 401

#### Scenario: Provider down
- **WHEN** a session is due for a refresh and the provider can't be reached
- **THEN** the request is handled with the existing session, and the refresh is tried again later

#### Scenario: Token not stored
- **WHEN** a session is started
- **THEN** `friday.db` holds the token's hash, not the token

### Requirement: Users can log out

`POST /auth/logout` SHALL end the current session, clear the cookie and answer 200 with `{ "endSessionUrl": <url or null> }`, also without a session. The URL SHALL be the provider's end-session URL when the provider advertises one, so the portal can offer it. It SHALL be subject to the cross-origin rule of `http-server`. It SHALL NOT end the session at the provider.

#### Scenario: Log out
- **WHEN** a logged-in user posts `/auth/logout`
- **THEN** the session is ended, the cookie is cleared, and a later request with the old cookie gets 401

#### Scenario: Cross-site logout
- **WHEN** a request to `POST /auth/logout` carries `Origin: https://evil.example`
- **THEN** the response is 403 and the session is kept

### Requirement: API access depends on the session and the role

Every request to `/api/` SHALL be answered with 401 and `{ "error": "unauthenticated" }` when it has no session. A disabled user's requests SHALL be answered the same way. The following SHALL be admin-only and SHALL answer 403 with `{ "error": "forbidden" }` to a member:
- `/api/config` and everything under it, `/api/mcp/`, `/api/keys`, `/api/devices`, `/api/oauth/`, `/api/jobs`, `/api/alerts`, `/api/users` and everything under them;
- `POST /api/modules/:id/reload`.

All other `/api/` requests SHALL be open to every user, including module routes under `/api/modules/<id>/`. The check SHALL apply to every route under these prefixes, including routes added later. `/health`, `/auth/` routes and static files SHALL need no session. Voice device and remote module connections SHALL keep their own authentication as specified in `audio-transport` and `remote-modules`.

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

#### Scenario: Health stays open
- **WHEN** the kubelet requests `/health` without a cookie
- **THEN** the response is 200

### Requirement: Admins can disable users

An admin SHALL be able to disable and enable a user. Disabling SHALL end all of that user's sessions straight away, close their open browser voice sessions, and refuse their later logins with the no-access page until they are enabled again. An admin SHALL NOT be able to disable themselves (409). The dev user SHALL NOT be disabled.

#### Scenario: Disable a member
- **WHEN** an admin disables member `u2` while `u2` has two sessions
- **THEN** both sessions end, and `u2`'s next request gets 401 and their next login is refused

#### Scenario: Disable oneself
- **WHEN** an admin tries to disable their own user
- **THEN** the response is 409 and nothing changes

### Requirement: The first admin becomes the household owner

The first user who logs in with role `admin` SHALL be recorded as the household owner, exactly once. Core SHALL NOT change the owner afterwards, also not when that user later loses the admin role or is disabled. The dev user SHALL NOT become the owner. The owner SHALL be reported by the users API. Later per-user features assign existing data to the owner.

#### Scenario: First admin
- **WHEN** no owner is recorded and an admin logs in for the first time
- **THEN** that user is recorded as the owner

#### Scenario: A member first
- **WHEN** no owner is recorded and a member logs in
- **THEN** no owner is recorded

#### Scenario: Second admin
- **WHEN** an owner is recorded and another admin logs in for the first time
- **THEN** the owner is unchanged

### Requirement: Users API

Core SHALL serve:
- `GET /api/me`: the current user's `id`, `name`, `email`, `role` and `owner` (boolean), and `authEnabled`.
- `GET /api/users` (admin): every user with `id`, `name`, `email`, `role`, `owner`, `disabled`, `firstLoginAt` and `lastLoginAt`.
- `POST /api/users/:id/disable` and `POST /api/users/:id/enable` (admin): answer with the user.

Unknown ids SHALL respond 404. No response SHALL contain a session token, a refresh token or a subject.

#### Scenario: Who am I
- **WHEN** a member requests `GET /api/me`
- **THEN** the response holds their id, name, email, role `member` and `owner: false`

#### Scenario: List users
- **WHEN** an admin requests `GET /api/users`
- **THEN** each user is listed with role, owner flag, disabled flag and login times, and no tokens

### Requirement: Users page

The portal SHALL provide `System > Users` at `/settings/users` for admins. It SHALL show one table row per user: a status dot (active or disabled), name, email, role, an `owner` badge for the owner, and first and last login. Clicking a row SHALL open a drawer with `Disable` (with confirmation) or `Enable`. The drawer SHALL NOT offer `Disable` for the current user or the dev user. Help text SHALL explain that users appear after their first login, and that access and roles are managed in Authentik groups.

#### Scenario: Disable from the page
- **WHEN** an admin opens member `Sanne` on the Users page and confirms `Disable`
- **THEN** the row for `Sanne` shows the disabled status

#### Scenario: Own row
- **WHEN** an admin opens their own row
- **THEN** no `Disable` action is offered
