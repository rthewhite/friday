# Spec Delta

## MODIFIED Requirements

### Requirement: HTTP server serves the web client and tool declarations

The server SHALL listen on `FRIDAY_HOST`:`FRIDAY_PORT` (default `0.0.0.0:8080`), serve the built portal from `FRIDAY_WEB_DIR` (default: the portal package's `dist`) with `/` mapping to `index.html`, return the current tool declarations as JSON at `/api/tools`, and fall back to `index.html` for any GET that is not under `/api`, `/ws`, `/health` and does not match a file. Requests resolving outside the web directory SHALL be rejected with 400.

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
- **WHEN** a client requests `/api/nope`
- **THEN** the server responds 404, not `index.html`

#### Scenario: Path traversal
- **WHEN** a client requests `/../package.json`
- **THEN** the server responds 400

#### Scenario: Tool declarations
- **WHEN** a client requests `/api/tools`
- **THEN** the server responds with the JSON array of Gemini function declarations

## ADDED Requirements

### Requirement: Module routes are mounted

Requests under `/api/modules/<id>/` SHALL be dispatched to the module's registered routes; an unknown module or path responds 404.

#### Scenario: Dispatch
- **WHEN** media registered `GET search`
- **THEN** `/api/modules/media/search` reaches media's handler and `/api/modules/nope/search` responds 404
