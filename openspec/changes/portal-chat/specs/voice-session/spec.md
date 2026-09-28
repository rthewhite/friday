# Spec Delta

## MODIFIED Requirements

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

### Requirement: System prompt defines Friday's persona and end-of-conversation policy

The voice system prompt SHALL consist of the shared base prompt, which is also used by chat, followed by the voice part. The base SHALL instruct the model to prefer tools over guessing and answer in the user's language. The voice part SHALL instruct the model to keep spoken answers short, call `end_conversation` in the same turn as its final confirmation or goodbye, and NOT end while awaiting user input or a pending tool result.

#### Scenario: Request fully handled
- **WHEN** the model has completed a request and has no follow-up question
- **THEN** it is instructed to confirm briefly and call `end_conversation` in the same turn

#### Scenario: Clarification needed
- **WHEN** the model still needs information from the user
- **THEN** it is instructed not to call `end_conversation`

#### Scenario: Shared base
- **WHEN** the voice and chat system prompts are compared
- **THEN** both start with the same base, and only the voice prompt mentions `end_conversation`
