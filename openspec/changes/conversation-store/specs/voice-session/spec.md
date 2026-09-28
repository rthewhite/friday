# Spec Delta

## ADDED Requirements

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
