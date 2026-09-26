# Spec Delta

## MODIFIED Requirements

### Requirement: end_conversation

The tool SHALL be named `end_conversation`, accept an optional `reason`, return `{ ending: true, reason, endConversation: reason }` (reason defaulting to `done`), and use scheduling `SILENT`. The `endConversation` key is the reserved registry key that signals the session to close after the model's current turn; it is stripped before the result reaches Gemini.

#### Scenario: Called with reason
- **WHEN** the model calls `end_conversation` with `reason: "user said goodbye"`
- **THEN** Gemini receives `{ ending: true, reason: "user said goodbye" }` and the session closes after the turn with `ended: user said goodbye`

#### Scenario: Called without reason
- **WHEN** the model calls `end_conversation` with no args
- **THEN** the reason is `done`

## ADDED Requirements

### Requirement: Builtin tools ship as the `builtin` module

`get_current_time`, `set_timer` and `end_conversation` SHALL be provided by a module with id `builtin` in `modules/builtin`, defining its tools in `init(ctx)`.

#### Scenario: Module listed
- **WHEN** a client requests `/api/modules`
- **THEN** `builtin` is present with those three tool names
