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
