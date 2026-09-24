# Web Client

## Purpose

A single-page browser client (`web/index.html` + `web/capture-worklet.js`) that captures the microphone, streams PCM over the `/ws/audio` WebSocket, plays back Friday's speech, and shows a transcript with tool activity.

## Requirements

### Requirement: Microphone capture at 16 kHz s16le

An AudioWorklet SHALL downsample the microphone to 16 kHz mono signed 16-bit PCM and stream it in small, low-latency chunks. The microphone SHALL be requested with echo cancellation, noise suppression and auto gain control enabled.

#### Scenario: Capture running
- **WHEN** the session is live
- **THEN** PCM chunks are sent to the server as binary WebSocket frames

#### Scenario: Socket not open
- **WHEN** a chunk is produced while the WebSocket is not open
- **THEN** the chunk is dropped

### Requirement: Start and stop control

A single button SHALL toggle the session. Starting SHALL connect to `ws(s)://<host>/ws/audio` (scheme matching the page), set state to `connecting` then `live`, and mark the button as active with label `Stop`. Stopping SHALL release the microphone, disconnect the worklet, close the socket, and reset the UI to `idle` / `Start talking`.

#### Scenario: Start
- **WHEN** the user clicks `Start talking`
- **THEN** the mic and WebSocket are opened and the state shows `live`

#### Scenario: Stop by user
- **WHEN** the user clicks `Stop`
- **THEN** capture stops, the socket closes, queued playback is flushed immediately, and the state shows `idle`

#### Scenario: Start fails
- **WHEN** microphone or WebSocket setup throws
- **THEN** the state shows `error: <message>` and the client is reset

### Requirement: Playback of 24 kHz PCM

Binary frames from the server SHALL be decoded as 24 kHz mono s16le and scheduled gaplessly on a Web Audio context.

#### Scenario: Consecutive audio frames
- **WHEN** several audio frames arrive
- **THEN** they play back-to-back without gaps or overlap

#### Scenario: Interrupted
- **WHEN** an `interrupted` event arrives
- **THEN** all scheduled buffers are stopped, the play head resets, and the current bot transcript bubble is closed

### Requirement: Transcript and tool log

Text events SHALL be rendered as a transcript: `user_text` appends to the current user bubble, `bot_text` appends to the current bot bubble, `turn_complete` closes both, and `tool_call` / `tool_result` render as tool activity lines showing the tool name with its args or result. User, bot and tool entries SHALL be visually distinguishable.

#### Scenario: Streaming transcript
- **WHEN** several `bot_text` events arrive in one turn
- **THEN** they are concatenated into a single bot bubble

#### Scenario: Role switch
- **WHEN** a `user_text` arrives after `bot_text`
- **THEN** the bot bubble is closed and a new user bubble starts

#### Scenario: Tool call
- **WHEN** a `tool_call` event arrives
- **THEN** a tool activity line with the name and args is shown; on `tool_result` a line with the name and result is shown

### Requirement: Server-initiated close drains playback

On a `closed` event or socket close, the client SHALL show the close reason in the transcript, stop the microphone immediately, but let already-scheduled speech finish before closing the audio context.

#### Scenario: Friday ends the conversation
- **WHEN** the server sends `closed` while speech is still queued
- **THEN** capture stops at once and playback continues until the queue is empty, then the audio context closes

#### Scenario: Socket drops
- **WHEN** the WebSocket closes without a `closed` event
- **THEN** the client resets to idle, draining queued audio

### Requirement: Secure context requirement

The README SHALL state that browsers only allow microphone access on `localhost` or HTTPS.

#### Scenario: Remote HTTP access
- **WHEN** the page is opened over plain HTTP from a non-localhost host
- **THEN** microphone capture is unavailable and the documented workaround is to use localhost or HTTPS
