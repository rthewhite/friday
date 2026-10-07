## MODIFIED Requirements

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
