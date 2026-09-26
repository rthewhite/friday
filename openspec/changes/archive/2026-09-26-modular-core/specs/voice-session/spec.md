# Spec Delta

## MODIFIED Requirements

### Requirement: Model-initiated end of conversation

When a tool call returns an `endConversation` request (as the builtin `end_conversation` tool does), the session SHALL close after the current turn completes so the model's final words are delivered, and the `closed` event SHALL carry `ended: <reason>`. Once an end has been requested, the session SHALL NOT forward an `interrupted` event for the remainder of that turn, because Gemini marks its own turn as interrupted when the tool response arrives and clients would otherwise discard the final words. The session SHALL NOT reference any tool by name.

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
