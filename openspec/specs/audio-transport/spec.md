# Audio Transport

## Purpose

A raw WebSocket at `/ws/audio` carrying PCM audio both ways plus JSON events. The same protocol is intended for browsers and microcontrollers (ESP32 / Voice PE). Each transport wraps a `GeminiSession` so tool and prompt behaviour is shared across clients; a WebRTC transport may be added alongside later.

## Requirements

### Requirement: WebSocket protocol at /ws/audio

Each WebSocket connection SHALL own one `GeminiSession`. Client-to-server binary frames SHALL be 16 kHz mono s16le PCM; client-to-server text frames SHALL be JSON `{"type":"text","text":"..."}`. Server-to-client binary frames SHALL be 24 kHz mono s16le PCM; server-to-client text frames SHALL be JSON `{"type":<event kind>,"data":<payload>}` for the kinds `interrupted`, `user_text`, `bot_text`, `tool_call`, `tool_result`, `turn_complete`, `closed`.

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

#### Scenario: Audio event
- **WHEN** the session emits an `audio` event
- **THEN** the PCM is sent to the client as a binary frame

#### Scenario: Non-audio event
- **WHEN** the session emits any other event
- **THEN** it is sent to the client as a JSON text frame with `type` and `data`

#### Scenario: Session closed
- **WHEN** the session emits `closed`
- **THEN** the `closed` JSON frame is sent and the WebSocket is closed afterwards

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

The server SHALL accept an optional `device` query parameter on `/ws/audio`, log it with the connection, and otherwise ignore it. Connections without the parameter SHALL behave exactly as before. The server SHALL ignore unknown query parameters.

#### Scenario: Device identifier present
- **WHEN** a client connects to `/ws/audio?device=kitchen`
- **THEN** the connection is accepted and the log line for the session includes `kitchen`

#### Scenario: No identifier
- **WHEN** a client connects to `/ws/audio` without query parameters
- **THEN** the connection is accepted as today

#### Scenario: Unknown parameter
- **WHEN** a client connects with a query parameter the server does not recognise
- **THEN** the connection is accepted and the parameter is ignored

### Requirement: Binary frame size

The server SHALL accept client binary audio frames of any size up to at least one second of 16 kHz s16le audio (32,000 bytes) in a single frame, so clients may batch capture to reduce overhead.

#### Scenario: Batched frames
- **WHEN** a client sends 100 ms of audio (3,200 bytes) per binary frame
- **THEN** every frame is forwarded to the session as audio

#### Scenario: Large frame
- **WHEN** a client sends a 32,000 byte binary frame
- **THEN** the frame is accepted and forwarded
