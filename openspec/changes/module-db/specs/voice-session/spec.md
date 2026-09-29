# Spec Delta

## MODIFIED Requirements

### Requirement: System prompt defines Friday's persona and end-of-conversation policy

The voice system prompt SHALL consist of the shared base prompt, which is also used by chat, followed by the voice part, followed by the module context for channel `voice` (as specified in `module-system`) when it is not empty. The module context SHALL be rendered when the session opens and SHALL stay fixed for the session's lifetime. The base SHALL instruct the model to prefer tools over guessing and answer in the user's language. The voice part SHALL instruct the model to keep spoken answers short, call `end_conversation` in the same turn as its final confirmation or goodbye, and NOT end while awaiting user input or a pending tool result.

#### Scenario: Request fully handled
- **WHEN** the model has completed a request and has no follow-up question
- **THEN** it is instructed to confirm briefly and call `end_conversation` in the same turn

#### Scenario: Clarification needed
- **WHEN** the model still needs information from the user
- **THEN** it is instructed not to call `end_conversation`

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
