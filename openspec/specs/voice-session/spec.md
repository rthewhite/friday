# Voice Session

## Purpose

A `GeminiSession` bridges one client conversation to the Gemini Live API. It is transport-agnostic: it accepts 16 kHz PCM audio or text in, emits typed events (audio, transcripts, tool activity, lifecycle) out, and decides when the conversation ends.

## Requirements

### Requirement: Session opens against Gemini Live with the configured model and voice

The session SHALL connect to Gemini Live using the Gemini API key resolved from core's configuration at the moment the session opens (as specified in `secret-management`), the model from `FRIDAY_MODEL` (default `gemini-3.8-live`), the prebuilt voice from `FRIDAY_VOICE` (default `Aoede`), audio-only response modality, input and output audio transcription enabled, the voice system prompt, and the declarations of every registered tool available in the `voice` channel. The session SHALL configure Gemini's automatic speech detection with the start-of-speech sensitivity from `FRIDAY_VAD_START_SENSITIVITY` (`LOW` by default, `HIGH` optional) and the minimum speech duration from `FRIDAY_VAD_PREFIX_MS` (default 200), so that residual echo of Friday's own voice on speaker devices does not register as the user interrupting.

#### Scenario: Session opens
- **WHEN** a transport opens a session
- **THEN** a Gemini Live connection is established with the configured model, voice, system prompt, speech detection settings and the declarations of all tools available in `voice`

#### Scenario: Chat-only tool
- **WHEN** a tool is registered with `channels: ["chat"]`
- **THEN** a voice session does not declare it

#### Scenario: Key changed between sessions
- **WHEN** a new `GEMINI_API_KEY` is saved in the portal while a session is open
- **THEN** the open session keeps its connection, and the next session connects with the new key

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

When a tool call returns an `endConversation` request (as the builtin `end_conversation` tool does), the session SHALL close after the current turn completes so the model's final words are delivered, and the `closed` event SHALL carry `ended: <reason>`. Once an end has been requested, the session SHALL NOT forward an `interrupted` event for the remainder of that turn, because Gemini marks its own turn as interrupted when the tool response arrives and clients would otherwise discard the final words. The session SHALL NOT reference any tool by name.

The exception is a turn that ends with a question. The session SHALL look at the output transcription received since the previous turn completed or was interrupted by the user. If that text ends with a question mark (`?`, `？`, `؟` or the Greek `;` U+037E) once trailing whitespace, closing quotes, closing brackets, `.`, `!` and `…` are ignored, the session SHALL NOT close when the turn completes. It SHALL drop the end request, so a later turn only ends the conversation when it asks again, and it SHALL arm the idle timer as for any other completed turn. The session SHALL log that it kept listening because the turn ended with a question. It SHALL go on withholding `interrupted` events until the user next speaks or sends text, so an interruption flag that Gemini sends late for the dropped end cannot discard the question the session stayed open for.

#### Scenario: Model ends conversation
- **WHEN** the model calls `end_conversation` with a reason and then finishes its turn
- **THEN** the Gemini connection is closed
- **AND** a `closed` event with data `ended: <reason>` is emitted

#### Scenario: Reason omitted
- **WHEN** `end_conversation` is called without a reason
- **THEN** the reason defaults to `done`

#### Scenario: Interrupted flag after end requested
- **WHEN** Gemini reports the turn as interrupted after an end has been requested
- **THEN** no `interrupted` event is emitted and queued audio on the client plays to the end

#### Scenario: Any tool may end the conversation
- **WHEN** a tool from another module returns `{ endConversation: "handed off" }`
- **THEN** the session closes after the turn with `ended: handed off`

#### Scenario: End requested after a question
- **WHEN** the model says "What would you like to share with me today?", calls `end_conversation` with reason `request done`, and finishes its turn
- **THEN** the session stays open and no `closed` event is emitted when the turn completes
- **AND** the idle timer is armed

#### Scenario: User answers the question
- **WHEN** an end request was dropped because the turn ended with a question, and the user then speaks and the model answers without requesting an end
- **THEN** the session stays open after that answer's turn completes

#### Scenario: Question in the middle of the turn
- **WHEN** the model says "Want the lights on? Done, they're on." and calls `end_conversation`
- **THEN** the session closes after the turn, because the turn does not end with a question

#### Scenario: Question mark before a closing quote
- **WHEN** the turn's transcription ends with `?"` or `?)` followed by whitespace, and an end was requested
- **THEN** the turn counts as ending with a question and the session stays open

#### Scenario: Full-width, Arabic and Greek question marks
- **WHEN** the turn's transcription ends with `？`, `؟` or `;` (U+037E) and an end was requested
- **THEN** the session stays open

#### Scenario: Question followed by other punctuation
- **WHEN** the turn's transcription ends with `?!`, `?…` or `?.` and an end was requested
- **THEN** the turn counts as ending with a question and the session stays open

#### Scenario: Late interrupted flag after a dropped end
- **WHEN** an end request was dropped because the turn ended with a question, and Gemini then reports an interruption before the user speaks or types
- **THEN** no `interrupted` event is emitted

#### Scenario: Barge-in before the next turn
- **WHEN** a turn ending with a question is interrupted by the user, and the next turn requests an end without any new transcription
- **THEN** the interrupted turn's words do not count, and the session closes after the next turn

### Requirement: Idle timeout closes the session

After a turn completes, the session SHALL close if the user has not spoken for `FRIDAY_IDLE_TIMEOUT_MS` (default 8000). The close reason SHALL be `ended: no follow-up (end after question)` when that turn's end request was dropped because it ended with a question, and `ended: no follow-up` otherwise. A value of 0 SHALL disable the timeout, including after a dropped end request. The timer SHALL NOT be armed while any tool call is in flight, and SHALL be cancelled when the user speaks or a new tool call starts.

#### Scenario: User stays silent
- **WHEN** a turn completes and no input transcription arrives within the idle timeout
- **THEN** the session closes with `ended: no follow-up`

#### Scenario: User stays silent after a question with an end request
- **WHEN** an end request was dropped because the turn ended with a question, and no input transcription arrives within the idle timeout
- **THEN** the session closes with `ended: no follow-up (end after question)`

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

The voice system prompt SHALL consist of, in order:
1. the shared base prompt, which is also used by chat,
2. the voice part,
3. the module context for channel `voice` (as specified in `module-system`), when it is not empty,
4. when the session belongs to a registered voice device (as specified in `voice-devices`), a device block.

The module context and the device block SHALL be rendered when the session opens and SHALL stay fixed for the session's lifetime.

The base SHALL instruct the model to prefer tools over guessing and answer in the user's language.

The voice part SHALL instruct the model to keep spoken answers short, call `end_conversation` in the same turn as its final confirmation or goodbye, and NOT end while awaiting user input or a pending tool result. It SHALL also state that the model must never call `end_conversation` in a turn whose reply ends with a question or invites the user to talk, and that an invitation to chat, tell something or share information starts an open conversation rather than completing a request.

The device block SHALL:
- name the device's label,
- when the device has an area, state that the user is in that Home Assistant area and that requests which name no room, area or floor (such as turning on "the lights") apply to that area,
- include the device's notes when it has any.

#### Scenario: Request fully handled
- **WHEN** the model has completed a request and has no follow-up question
- **THEN** it is instructed to confirm briefly and call `end_conversation` in the same turn

#### Scenario: Clarification needed
- **WHEN** the model still needs information from the user
- **THEN** it is instructed not to call `end_conversation`

#### Scenario: Reply ends with a question
- **WHEN** the model's reply ends with a question or invites the user to talk
- **THEN** it is instructed not to call `end_conversation` in that turn

#### Scenario: Invitation to talk
- **WHEN** the user asks Friday to have a conversation or offers to share something
- **THEN** the prompt treats it as an open conversation, not a finished request

#### Scenario: Shared base
- **WHEN** the voice and chat system prompts are compared
- **THEN** both start with the same base, and only the voice prompt mentions `end_conversation`

#### Scenario: Module context in a voice session
- **WHEN** module `brain` provides context and a voice session opens
- **THEN** the session's system instruction is the base, the voice part, and then the `brain` context

#### Scenario: Context changes during a session
- **WHEN** a provider's output changes while a voice session is open
- **THEN** the open session keeps its instruction, and the next session uses the new output

#### Scenario: No module context
- **WHEN** no provider returns text and the session has no device
- **THEN** the system instruction is the base and the voice part only

#### Scenario: Device with an area
- **WHEN** registered device `Kitchen satellite` with area `Kitchen` and notes `Next to the fridge` opens a session
- **THEN** the system instruction ends with a device block naming `Kitchen satellite`, stating that requests without a room apply to the area `Kitchen`, and including `Next to the fridge`

#### Scenario: Device without an area
- **WHEN** a registered device with no area and no notes opens a session
- **THEN** the device block names the device's label and states no default area

#### Scenario: Session without a device
- **WHEN** the portal's Talk page opens a session without a device
- **THEN** the system instruction has no device block

#### Scenario: Device edited during a session
- **WHEN** a device's area is changed while it has a session open
- **THEN** the open session keeps its device block, and the next session uses the new area

### Requirement: The session records its conversation

When given a recorder, a session SHALL record its conversation as specified in `conversation-store`, with channel `voice`: input transcriptions as user entries with input `speech`, text sent through the session as user entries with input `text`, output transcriptions as assistant entries (marked `interrupted` when Gemini reports an interruption), each tool call with its arguments and result, and the reason from its single `closed` event as the end reason. Recording SHALL NOT change what the session emits to its transport, or when it closes.

#### Scenario: Typed text is recorded
- **WHEN** a client sends `{"type":"text","text":"what time is it"}` and the model answers
- **THEN** the conversation holds a user entry with input `text` and the assistant's answer

#### Scenario: End reason
- **WHEN** the model calls `end_conversation` with reason `done` and the session closes
- **THEN** the conversation is quiet with end reason `ended: done`

#### Scenario: Events unchanged
- **WHEN** a session records its conversation
- **THEN** the client receives exactly the events it would receive without recording
