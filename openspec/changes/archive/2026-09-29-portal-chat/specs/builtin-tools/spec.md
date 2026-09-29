# Spec Delta

## MODIFIED Requirements

### Requirement: set_timer

The tool SHALL wait `seconds` (required integer) and then return `{ done: true, label, message }`, where `label` defaults to `timer`. Its default scheduling SHALL be `WHEN_IDLE` so the model announces completion without interrupting the user. It SHALL be available only in the `voice` channel, because a chat turn waits for every tool result before it answers.

#### Scenario: Timer completes
- **WHEN** called with `seconds: 5, label: "eggs"`
- **THEN** after 5 seconds the result is `{ done: true, label: "eggs", message: "eggs finished after 5 seconds" }` with scheduling `WHEN_IDLE`

#### Scenario: Timer keeps session alive
- **WHEN** a timer is running and the model finishes its turn
- **THEN** the session's idle timeout is not armed until the timer completes

#### Scenario: Not offered in chat
- **WHEN** a chat turn starts
- **THEN** `set_timer` is not among its declarations

### Requirement: end_conversation

The tool SHALL be named `end_conversation`, accept an optional `reason`, return `{ ending: true, reason, endConversation: reason }` (reason defaulting to `done`), and use scheduling `SILENT`. The `endConversation` key is the reserved registry key that signals the session to close after the model's current turn; it is stripped before the result reaches Gemini. It SHALL be available only in the `voice` channel.

#### Scenario: Called with reason
- **WHEN** the model calls `end_conversation` with `reason: "user said goodbye"`
- **THEN** Gemini receives `{ ending: true, reason: "user said goodbye" }` and the session closes after the turn with `ended: user said goodbye`

#### Scenario: Called without reason
- **WHEN** the model calls `end_conversation` with no args
- **THEN** the reason is `done`

#### Scenario: Not offered in chat
- **WHEN** a chat turn starts
- **THEN** `end_conversation` is not among its declarations
