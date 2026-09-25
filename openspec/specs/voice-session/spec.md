# Voice Session

## Purpose

A `GeminiSession` bridges one client conversation to the Gemini Live API. It is transport-agnostic: it accepts 16 kHz PCM audio or text in, emits typed events (audio, transcripts, tool activity, lifecycle) out, and decides when the conversation ends.

## Requirements

### Requirement: Session opens against Gemini Live with the configured model and voice

The session SHALL connect to Gemini Live using the model from `FRIDAY_MODEL` (default `gemini-3.8-live`), the prebuilt voice from `FRIDAY_VOICE` (default `Aoede`), audio-only response modality, input and output audio transcription enabled, the Friday system prompt, and the declarations of every registered tool. The session SHALL configure Gemini's automatic speech detection with the start-of-speech sensitivity from `FRIDAY_VAD_START_SENSITIVITY` (`LOW` by default, `HIGH` optional) and the minimum speech duration from `FRIDAY_VAD_PREFIX_MS` (default 200), so that residual echo of Friday's own voice on speaker devices does not register as the user interrupting.

#### Scenario: Session opens
- **WHEN** a transport opens a session
- **THEN** a Gemini Live connection is established with the configured model, voice, system prompt, speech detection settings and all tool declarations

#### Scenario: Gemini is unavailable
- **WHEN** the Live connection cannot be established
- **THEN** `open()` rejects and the transport is responsible for closing the client with an error

#### Scenario: Residual echo during playback
- **WHEN** a faint, brief copy of Friday's speech reaches the microphone while Friday is talking
- **THEN** with the default settings Gemini does not report an interruption and playback continues

#### Scenario: Real barge-in
- **WHEN** the user speaks over Friday for longer than the configured prefix duration
- **THEN** Gemini reports an interruption as before

### Requirement: Audio and text input are forwarded to Gemini

The session SHALL forward audio as realtime input with mime type `audio/pcm;rate=16000`, and text as a user turn.

#### Scenario: Audio input
- **WHEN** the transport calls `sendAudio` with 16 kHz mono s16le PCM
- **THEN** the audio is sent to Gemini as realtime input

#### Scenario: Audio after close
- **WHEN** the session is already closed
- **THEN** `sendAudio` is a no-op

#### Scenario: Text input
- **WHEN** the transport calls `sendText`
- **THEN** the text is sent to Gemini as a user turn

### Requirement: Server messages are surfaced as events

The session SHALL translate Gemini Live server messages into events: `audio` (24 kHz PCM), `interrupted`, `user_text`, `bot_text`, `turn_complete`, `tool_call`, `tool_result`, and `closed`.

#### Scenario: Model speaks
- **WHEN** Gemini returns inline audio data
- **THEN** an `audio` event carrying the decoded PCM buffer is emitted

#### Scenario: Transcripts
- **WHEN** Gemini returns an input or output transcription
- **THEN** a `user_text` or `bot_text` event with the transcript text is emitted

#### Scenario: User barges in
- **WHEN** Gemini reports the model turn was interrupted
- **THEN** an `interrupted` event is emitted so clients can drop buffered playback

#### Scenario: Turn ends
- **WHEN** Gemini reports the turn is complete
- **THEN** a `turn_complete` event is emitted

### Requirement: Tool calls run in the background

Tool calls from Gemini SHALL be dispatched to the tool registry without blocking audio streaming. Each call SHALL emit `tool_call` before running and `tool_result` after, and the result SHALL be returned to Gemini together with its scheduling hint.

#### Scenario: Tool call
- **WHEN** Gemini requests a function call
- **THEN** a `tool_call` event with name and args is emitted
- **AND** the tool executes asynchronously while audio continues to flow
- **AND** a `tool_result` event is emitted and the response is sent to Gemini with the tool's `scheduling`

#### Scenario: Multiple concurrent tool calls
- **WHEN** Gemini requests several function calls in one message
- **THEN** all of them run concurrently

### Requirement: Model-initiated end of conversation

When the model calls `end_conversation`, the session SHALL close after the current turn completes so the model's final words are delivered, and the `closed` event SHALL carry `ended: <reason>`. Once `end_conversation` has been called, the session SHALL NOT forward an `interrupted` event for the remainder of that turn, because Gemini marks its own turn as interrupted when the tool response arrives and clients would otherwise discard the final words.

#### Scenario: Model ends conversation
- **WHEN** the model calls `end_conversation` with a reason and then finishes its turn
- **THEN** the Gemini connection is closed
- **AND** a `closed` event with data `ended: <reason>` is emitted

#### Scenario: Reason omitted
- **WHEN** `end_conversation` is called without a reason
- **THEN** the reason defaults to `done`

#### Scenario: Interrupted flag after end requested
- **WHEN** Gemini reports the turn as interrupted after `end_conversation` has been called
- **THEN** no `interrupted` event is emitted and queued audio on the client plays to the end

### Requirement: Idle timeout closes the session

After a turn completes, the session SHALL close with reason `ended: no follow-up` if the user has not spoken for `FRIDAY_IDLE_TIMEOUT_MS` (default 8000). A value of 0 SHALL disable the timeout. The timer SHALL NOT be armed while any tool call is in flight, and SHALL be cancelled when the user speaks or a new tool call starts.

#### Scenario: User stays silent
- **WHEN** a turn completes and no input transcription arrives within the idle timeout
- **THEN** the session closes with `ended: no follow-up`

#### Scenario: User speaks again
- **WHEN** an input transcription arrives before the idle timeout fires
- **THEN** the idle timer is cancelled

#### Scenario: Tool pending
- **WHEN** a turn completes while a tool (e.g. a timer) is still running
- **THEN** the idle timer is not armed

#### Scenario: Timeout disabled
- **WHEN** `FRIDAY_IDLE_TIMEOUT_MS` is 0
- **THEN** the session never closes for inactivity

### Requirement: Close is idempotent and always emits exactly one closed event

The session SHALL emit exactly one `closed` event regardless of whether closing was triggered by the client, the model, the idle timer, or Gemini itself.

#### Scenario: Client disconnects
- **WHEN** the transport calls `close()`
- **THEN** the Gemini connection is closed and a `closed` event with `client closed` is emitted

#### Scenario: Gemini closes the connection
- **WHEN** Gemini closes the Live connection
- **THEN** a `closed` event carrying Gemini's close reason is emitted

#### Scenario: Repeated close
- **WHEN** close is triggered again after the session is already closed
- **THEN** no further `closed` event is emitted

### Requirement: System prompt defines Friday's persona and end-of-conversation policy

The system prompt SHALL instruct the model to be concise, prefer tools over guessing, answer in the user's language, call `end_conversation` in the same turn as its final confirmation or goodbye, and NOT end while awaiting user input or a pending tool result.

#### Scenario: Request fully handled
- **WHEN** the model has completed a request and has no follow-up question
- **THEN** it is instructed to confirm briefly and call `end_conversation` in the same turn

#### Scenario: Clarification needed
- **WHEN** the model still needs information from the user
- **THEN** it is instructed not to call `end_conversation`
