# Spec Delta

## ADDED Requirements

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
