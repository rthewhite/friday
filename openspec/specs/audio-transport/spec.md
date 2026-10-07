# Audio Transport

## Purpose

A raw WebSocket at `/ws/audio` carrying PCM audio both ways plus JSON events. The same protocol is intended for browsers and microcontrollers (ESP32 / Voice PE). Each transport wraps a `GeminiSession` so tool and prompt behaviour is shared across clients; a WebRTC transport may be added alongside later.

## Requirements

### Requirement: WebSocket protocol at /ws/audio

Each WebSocket connection SHALL own one `GeminiSession`. Client-to-server binary frames SHALL be 16 kHz mono s16le PCM; client-to-server text frames SHALL be JSON `{"type":"text","text":"..."}`, and any other text frame (not JSON, not an object, or without a string `text`) SHALL be ignored without closing the connection or affecting the server. Server-to-client binary frames SHALL be 24 kHz mono s16le PCM; server-to-client text frames SHALL be JSON `{"type":<event kind>,"data":<payload>}`.

Which event kinds a connection receives as text frames SHALL depend on the connection:
- a connection without a device identifier (the browser) SHALL receive `interrupted`, `user_text`, `bot_text`, `tool_call`, `tool_result`, `turn_complete` and `closed`;
- a connection authenticated as a voice device (as specified in `voice-devices`) SHALL receive only `interrupted`, `turn_complete` and `closed`. Transcripts and tool activity SHALL NOT be sent to it, since devices don't act on them and a tool result can be larger than a device can buffer.

What the session records in the conversation store SHALL NOT depend on which events are sent to the connection.

#### Scenario: Connection opens
- **WHEN** a client connects to `/ws/audio`
- **THEN** a new Gemini session is opened for that connection

#### Scenario: Gemini unavailable on connect
- **WHEN** the Gemini session cannot be opened
- **THEN** the WebSocket is closed with code 1011 and reason `gemini unavailable`

#### Scenario: Binary frame from client
- **WHEN** the client sends a binary frame
- **THEN** it is forwarded to the session as PCM audio

#### Scenario: Text frame from client
- **WHEN** the client sends `{"type":"text","text":"hello"}`
- **THEN** the text is sent to the session as a user turn

#### Scenario: Malformed text frame from client
- **WHEN** a client, with or without a device key, sends a text frame such as `{`, `null` or `{"type":"text","text":7}`
- **THEN** the frame is ignored, the connection stays open, and a valid text frame sent afterwards still reaches the session

#### Scenario: Audio event
- **WHEN** the session emits an `audio` event
- **THEN** the PCM is sent to the client as a binary frame, for browser and device connections alike

#### Scenario: Non-audio event
- **WHEN** the session of a connection without a device identifier (the browser) emits any other event
- **THEN** it is sent to the client as a JSON text frame with `type` and `data`

#### Scenario: Control event on a device connection
- **WHEN** the session of an authenticated device connection emits `interrupted` or `turn_complete`
- **THEN** it is sent to the device as a JSON text frame with `type` and `data`

#### Scenario: Transcript or tool event on a device connection
- **WHEN** the session of an authenticated device connection emits `user_text`, `bot_text`, `tool_call` or `tool_result`
- **THEN** nothing is sent to the device for it, and the conversation store still records the transcript and the tool call

#### Scenario: Session closed
- **WHEN** the session emits `closed`
- **THEN** the `closed` JSON frame is sent and the WebSocket is closed afterwards, for browser and device connections alike

#### Scenario: Client disconnects or errors
- **WHEN** the WebSocket closes or errors
- **THEN** the Gemini session is closed

#### Scenario: Send after socket closed
- **WHEN** an event arrives while the WebSocket is not open
- **THEN** the event is dropped

### Requirement: Connections are kept alive and dead connections are closed

The server SHALL send WebSocket pings on a regular interval and SHALL terminate a connection that does not answer with a pong before the next ping. Terminating the connection SHALL close the associated Gemini session. The server SHALL answer client pings with pongs.

#### Scenario: Healthy client
- **WHEN** a client answers each ping with a pong
- **THEN** the connection stays open indefinitely

#### Scenario: Client vanishes without a close frame
- **WHEN** a client stops responding, for example after losing Wi-Fi
- **THEN** the server terminates the connection within two ping intervals and the Gemini session is closed

#### Scenario: Client pings
- **WHEN** a client sends a ping
- **THEN** the server replies with a pong

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

### Requirement: Binary frame size

The server SHALL accept client binary audio frames of any size up to at least one second of 16 kHz s16le audio (32,000 bytes) in a single frame, so clients may batch capture to reduce overhead.

#### Scenario: Batched frames
- **WHEN** a client sends 100 ms of audio (3,200 bytes) per binary frame
- **THEN** every frame is forwarded to the session as audio

#### Scenario: Large frame
- **WHEN** a client sends a 32,000 byte binary frame
- **THEN** the frame is accepted and forwarded

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
