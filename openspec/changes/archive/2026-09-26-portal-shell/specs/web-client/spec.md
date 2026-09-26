# Spec Delta

## MODIFIED Requirements

### Requirement: Start and stop control

The portal's `Talk` page SHALL provide a single button that toggles the session. Starting SHALL connect to `ws(s)://<host>/ws/audio` (scheme matching the page), set state to `connecting` then `live`, and mark the button as active with label `Stop`. Stopping SHALL release the microphone, disconnect the worklet, close the socket, and reset the UI to `idle` / `Start talking`. Leaving the Talk route while live SHALL stop the session.

#### Scenario: Start
- **WHEN** the user clicks `Start talking`
- **THEN** the mic and WebSocket are opened and the state shows `live`

#### Scenario: Stop by user
- **WHEN** the user clicks `Stop`
- **THEN** capture stops, the socket closes, queued playback is flushed immediately, and the state shows `idle`

#### Scenario: Start fails
- **WHEN** microphone or WebSocket setup throws
- **THEN** the state shows `error: <message>` and the client is reset

#### Scenario: Navigate away
- **WHEN** the user opens another portal page during a live session
- **THEN** the session is stopped as if `Stop` was clicked

### Requirement: Microphone capture at 16 kHz s16le

An AudioWorklet, served as a plain JavaScript file from the portal's public assets, SHALL downsample the microphone to 16 kHz mono signed 16-bit PCM and stream it in small, low-latency chunks. The microphone SHALL be requested with echo cancellation, noise suppression and auto gain control enabled.

#### Scenario: Capture running
- **WHEN** the session is live
- **THEN** PCM chunks are sent to the server as binary WebSocket frames

#### Scenario: Socket not open
- **WHEN** a chunk is produced while the WebSocket is not open
- **THEN** the chunk is dropped
