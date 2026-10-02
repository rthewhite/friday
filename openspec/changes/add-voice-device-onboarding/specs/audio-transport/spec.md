# Spec Delta

## MODIFIED Requirements

### Requirement: Connect URL may carry a device identifier

The server SHALL accept an optional `device` query parameter on `/ws/audio`. A connection that carries it SHALL be authenticated as specified in "Device connections are authenticated before a session opens". Once accepted, it SHALL be logged with the id and recorded as the device of its conversation. Connections without the parameter SHALL behave exactly as before: they need no key, their conversations have no device, and their sessions get no device context. The server SHALL ignore unknown query parameters.

#### Scenario: Device identifier present
- **WHEN** registered device `kitchen` connects to `/ws/audio?device=kitchen` with its key
- **THEN** the connection is accepted, the log line for the session includes `kitchen`, and the recorded conversation has device `kitchen`

#### Scenario: No identifier
- **WHEN** a client connects to `/ws/audio` without query parameters
- **THEN** the connection is accepted as before, without a key, and the recorded conversation has no device

#### Scenario: Unknown parameter
- **WHEN** a registered device connects with its key and a query parameter the server does not recognise
- **THEN** the connection is accepted and the parameter is ignored

## ADDED Requirements

### Requirement: Device connections are authenticated before a session opens

A connection with a `device` query parameter SHALL present its key in an `Authorization: Bearer <key>` request header. The server SHALL decide whether to accept the connection before any Gemini session is opened for it. When it does not accept, it SHALL complete the WebSocket upgrade and close at once with:

| Case | Close code | Reason |
|---|---|---|
| Id or key malformed (as defined in `voice-devices`) | `4400` | `bad device` |
| No key | `4401` | `unauthorized` |
| Id is revoked | `4401` | `unauthorized` |
| Id is not registered | `4403` | `pending approval` |
| Id is registered and the key does not match | `4403` | `pending approval` |

An unregistered id, or a registered id with a different key, SHALL also be recorded as a pending attempt as specified in `voice-devices`. When the key matches a registered, non-revoked device, the server SHALL record the time as the device's last connection and open the session with that device's context. A key in the query string SHALL NOT be accepted.

#### Scenario: Accepted device
- **WHEN** registered device `kitchen` connects with its key
- **THEN** a Gemini session opens for it

#### Scenario: New device
- **WHEN** device `kitchen-2` that is not registered connects with a well-formed key
- **THEN** the socket is closed with `4403 pending approval`, no Gemini session is opened, and a pending attempt for `kitchen-2` is recorded

#### Scenario: Missing key
- **WHEN** a client connects to `/ws/audio?device=kitchen` without an `Authorization` header
- **THEN** the socket is closed with `4401 unauthorized` and no Gemini session is opened

#### Scenario: Revoked device
- **WHEN** revoked device `kitchen` connects with any key
- **THEN** the socket is closed with `4401 unauthorized` and no pending attempt is recorded

#### Scenario: Malformed id
- **WHEN** a client connects with `?device=Kitchen!` and a key
- **THEN** the socket is closed with `4400 bad device`

#### Scenario: Key in the URL
- **WHEN** a client connects to `/ws/audio?device=kitchen&key=<the right key>` without an `Authorization` header
- **THEN** the socket is closed with `4401 unauthorized`

### Requirement: Revoking or replacing a device ends its open sessions

When a device is revoked or deleted, or its key is replaced, the server SHALL close every open connection of that device with `4401 unauthorized`, and the Gemini session of each SHALL be closed.

#### Scenario: Revoked mid-conversation
- **WHEN** the user revokes `kitchen` while it has a session open
- **THEN** its socket is closed with `4401` and its Gemini session is closed
