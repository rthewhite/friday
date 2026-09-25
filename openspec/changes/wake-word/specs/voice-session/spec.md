# Spec Delta

## MODIFIED Requirements

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
