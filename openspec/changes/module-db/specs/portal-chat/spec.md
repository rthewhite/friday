# Spec Delta

## MODIFIED Requirements

### Requirement: A chat turn runs against the chat model

Each chat message SHALL be answered by one turn against a non-Live Gemini text model, using the model from `FRIDAY_CHAT_MODEL`, falling back to `FRIDAY_TEXT_MODEL`, and the Gemini API key resolved from core's configuration for each model call of the turn (as specified in `secret-management`). The turn SHALL send the chat system prompt, the thread's history, the new message, and the declarations of the tools available in the `chat` channel, read from the registry when the turn starts. The chat system prompt SHALL be the shared base and the chat part, followed by the module context for channel `chat` (as specified in `module-system`) when it is not empty. The module context SHALL be rendered once when the turn starts and used for every model call of that turn. The chat part of the prompt SHALL allow markdown and complete answers instead of short spoken ones.

#### Scenario: Model fallback
- **WHEN** `FRIDAY_CHAT_MODEL` is unset and `FRIDAY_TEXT_MODEL` is `gemini-flash-latest`
- **THEN** chat turns use `gemini-flash-latest`

#### Scenario: Tools changed between turns
- **WHEN** an MCP server is added in the portal between two messages of the same thread
- **THEN** the second turn declares that server's tools

#### Scenario: Voice-only tools are not offered
- **WHEN** a chat turn starts
- **THEN** its declarations contain `get_current_time` and do not contain `set_timer` or `end_conversation`

#### Scenario: Module context in a chat turn
- **WHEN** module `brain` provides context and a chat message is sent
- **THEN** every model call of that turn uses the base, the chat part, and then the `brain` context

#### Scenario: Context changes between turns
- **WHEN** a provider's output changes between two messages of the same thread
- **THEN** the second turn uses the new output
