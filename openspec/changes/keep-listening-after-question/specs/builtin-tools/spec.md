## MODIFIED Requirements

### Requirement: end_conversation

The tool SHALL be named `end_conversation`, accept an optional `reason`, return `{ ending: true, reason, endConversation: reason }` (reason defaulting to `done`), and use scheduling `SILENT`. The `endConversation` key is the reserved registry key that signals the session to close after the model's current turn; it is stripped before the result reaches Gemini. It SHALL be available only in the `voice` channel. Its description SHALL tell the model to call it in the same turn as its final words once a request is fully handled or the user says goodbye, and never when those final words are a question or invite the user to talk.

#### Scenario: Called with reason
- **WHEN** the model calls `end_conversation` with `reason: "user said goodbye"`
- **THEN** Gemini receives `{ ending: true, reason: "user said goodbye" }` and the session closes after the turn with `ended: user said goodbye`

#### Scenario: Called without reason
- **WHEN** the model calls `end_conversation` with no args
- **THEN** the reason is `done`

#### Scenario: Not offered in chat
- **WHEN** a chat turn starts
- **THEN** `end_conversation` is not among its declarations

#### Scenario: Description forbids ending after a question
- **WHEN** the voice declarations are listed
- **THEN** the `end_conversation` description says not to call it when the final words are a question
