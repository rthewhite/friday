## MODIFIED Requirements

### Requirement: HTTP server serves the web client and tool declarations

The server SHALL listen on `FRIDAY_HOST`:`FRIDAY_PORT` (default `0.0.0.0:8080`), serve the built portal from `FRIDAY_WEB_DIR` (default: the portal package's `dist`) with `/` mapping to `index.html`, return the current tool declarations as JSON at `/api/tools` to a request with a session (as specified in `user-auth`), and fall back to `index.html` for any GET that is not under `/api`, `/auth`, `/ws`, `/health` and does not match a file. Requests resolving outside the web directory SHALL be rejected with 400. The portal's files and the fallback SHALL be served without a session.

#### Scenario: Root request
- **WHEN** a client requests `/`
- **THEN** the portal `index.html` is served as `text/html`

#### Scenario: Static asset
- **WHEN** a client requests a path that exists under the web directory
- **THEN** the file is served with a content type appropriate to its extension

#### Scenario: SPA route
- **WHEN** a client requests `/m/media` directly
- **THEN** `index.html` is served so the router can render it

#### Scenario: Missing file
- **WHEN** a client requests a non-API path that does not exist under the web directory
- **THEN** `index.html` is served (SPA fallback) rather than 404

#### Scenario: Missing API path
- **WHEN** a client with a session requests `/api/nope`
- **THEN** the server responds 404, not `index.html`

#### Scenario: Unknown auth path
- **WHEN** a client requests `/auth/nope`
- **THEN** the server responds 404, not `index.html`

#### Scenario: Path traversal
- **WHEN** a client requests `/../package.json`
- **THEN** the server responds 400

#### Scenario: Tool declarations
- **WHEN** a client with a session requests `/api/tools`
- **THEN** the server responds with the JSON array of Gemini function declarations

#### Scenario: Portal without a session
- **WHEN** a client without a session requests `/` or a file under the web directory
- **THEN** the file is served, so the portal can load and send the user to log in

## ADDED Requirements

### Requirement: API requests are checked before they are routed

The server SHALL check the session and role of every `/api/` request, as specified in `user-auth`, before dispatching it to a core route or a module route. An unknown path under `/api/` SHALL answer 401 to a request without a session, and 404 only to a request with one, so that unauthenticated clients cannot discover routes. The cross-origin check SHALL run before the session check.

#### Scenario: Unknown path without a session
- **WHEN** a client without a session requests `/api/nope`
- **THEN** the server responds 401

#### Scenario: Cross-site write without a session
- **WHEN** a request to `POST /api/chat` carries `Origin: https://evil.example` and no session
- **THEN** the server responds 403
