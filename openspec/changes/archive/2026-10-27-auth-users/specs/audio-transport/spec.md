## MODIFIED Requirements

### Requirement: Connect URL may carry a device identifier

The server SHALL accept an optional `device` query parameter on `/ws/audio`. A connection that carries it SHALL be authenticated as specified in "Device connections are authenticated before a session opens". Once accepted, it SHALL be logged with the id and recorded as the device of its conversation. A connection without the parameter is a browser connection: it SHALL be authenticated as specified in "Browser connections need a session", its conversation has no device, and its session gets no device context. The server SHALL ignore unknown query parameters.

#### Scenario: Device identifier present
- **WHEN** registered device `kitchen` connects to `/ws/audio?device=kitchen` with its key
- **THEN** the connection is accepted, the log line for the session includes `kitchen`, and the recorded conversation has device `kitchen`

#### Scenario: No identifier
- **WHEN** a logged-in user's browser connects to `/ws/audio` without query parameters
- **THEN** the connection is accepted without a device key, and the recorded conversation has no device

#### Scenario: Unknown parameter
- **WHEN** a registered device connects with its key and a query parameter the server does not recognise
- **THEN** the connection is accepted and the parameter is ignored

## ADDED Requirements

### Requirement: Browser connections need a session

A connection to `/ws/audio` without a `device` query parameter SHALL be accepted only when the upgrade request carries a valid session of a user who is not disabled, as specified in `user-auth`. Otherwise the server SHALL refuse the upgrade with HTTP 401, before any Gemini session is opened. The upgrade SHALL also be refused with 403 when it carries an `Origin` header whose host differs from the request's `Host`. An accepted browser connection SHALL belong to that user for its whole life. A `device` parameter that is present, even empty, SHALL always be authenticated as a device, never as a browser. When the session a browser connection was opened with ends (logout, a refused claim refresh, idle expiry) or its user is disabled, the server SHALL close that connection with `4401 unauthorized`.

#### Scenario: Logged in
- **WHEN** a browser with a valid session opens `/ws/audio`
- **THEN** the connection is accepted and its session belongs to that user

#### Scenario: No session
- **WHEN** a client without a session cookie opens `/ws/audio`
- **THEN** the upgrade is refused with 401 and no Gemini session is opened

#### Scenario: Empty device parameter
- **WHEN** a client opens `/ws/audio?device=` without a key
- **THEN** it is refused as an unauthorized device, whatever session cookie it carries

#### Scenario: Cross-site page
- **WHEN** a page on `https://evil.example` opens a WebSocket to `/ws/audio` in a browser that has a Friday session
- **THEN** the upgrade is refused with 403

#### Scenario: Logged out in another tab
- **WHEN** a user has the Talk page open in a session and logs out in another tab of the same browser
- **THEN** that connection is closed with `4401` and its Gemini session is closed

#### Scenario: User disabled mid-session
- **WHEN** an admin disables a user who has the Talk page open in a session
- **THEN** that connection is closed with `4401` and its Gemini session is closed
