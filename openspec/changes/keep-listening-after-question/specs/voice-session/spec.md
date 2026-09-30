## MODIFIED Requirements

### Requirement: Model-initiated end of conversation

When a tool call returns an `endConversation` request (as the builtin `end_conversation` tool does), the session SHALL close after the current turn completes so the model's final words are delivered, and the `closed` event SHALL carry `ended: <reason>`. Once an end has been requested, the session SHALL NOT forward an `interrupted` event for the remainder of that turn, because Gemini marks its own turn as interrupted when the tool response arrives and clients would otherwise discard the final words. The session SHALL NOT reference any tool by name.

The exception is a turn that ends with a question. If the output transcription received since the previous turn completed ends with a question mark (`?`, `？` or `؟`) once trailing whitespace, closing quotes and closing brackets are ignored, the session SHALL NOT close when that turn completes. It SHALL drop the end request, so a later turn only ends the conversation when it asks again, and it SHALL arm the idle timer as for any other completed turn. The session SHALL log that it kept listening because the turn ended with a question.

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

#### Scenario: Full-width and Arabic question marks
- **WHEN** the turn's transcription ends with `？` or `؟` and an end was requested
- **THEN** the session stays open

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

### Requirement: System prompt defines Friday's persona and end-of-conversation policy

The voice system prompt SHALL consist of the shared base prompt, which is also used by chat, followed by the voice part, followed by the module context for channel `voice` (as specified in `module-system`) when it is not empty. The module context SHALL be rendered when the session opens and SHALL stay fixed for the session's lifetime. The base SHALL instruct the model to prefer tools over guessing and answer in the user's language. The voice part SHALL instruct the model to keep spoken answers short, call `end_conversation` in the same turn as its final confirmation or goodbye, and NOT end while awaiting user input or a pending tool result. It SHALL also state that the model must never call `end_conversation` in a turn whose reply ends with a question or invites the user to talk, and that an invitation to chat, tell something or share information starts an open conversation rather than completing a request.

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
- **WHEN** no provider returns text
- **THEN** the system instruction is the base and the voice part only
