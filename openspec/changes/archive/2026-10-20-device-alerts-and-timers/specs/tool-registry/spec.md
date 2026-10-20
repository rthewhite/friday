# Spec Delta

## MODIFIED Requirements

### Requirement: Calls are dispatched by name with scheduling resolution

`callTool` SHALL invoke the handler with the given args (empty object if none) and a call context, and return `{ result, scheduling, endConversation? }`. The call context SHALL carry the `channel`, `conversationId` and `device` passed in `callTool`'s options, each absent when not given. A voice session SHALL pass channel `voice` and a chat turn SHALL pass channel `chat`, each with the id of the conversation the call is recorded in once that conversation is stored, and without one before. A voice session of a registered voice device SHALL also pass that device's id as `device`; other sessions and chat turns SHALL NOT pass one. Tools served by MCP servers and remote modules SHALL NOT receive the call context. Scheduling SHALL be resolved in order: a `scheduling` key in the handler's returned object (which is then stripped from the result), the tool's default `scheduling`, then `INTERRUPT`. Valid values are `INTERRUPT`, `WHEN_IDLE`, `SILENT`. If the handler's returned object has a string `endConversation` key, it SHALL be stripped from the result and returned as `endConversation`.

#### Scenario: Default scheduling
- **WHEN** a tool without `scheduling` returns a plain result
- **THEN** scheduling is `INTERRUPT`

#### Scenario: Tool-level default
- **WHEN** a tool declares `scheduling: "WHEN_IDLE"` and returns a plain result
- **THEN** scheduling is `WHEN_IDLE`

#### Scenario: Per-call override
- **WHEN** a handler returns `{ ..., scheduling: "SILENT" }`
- **THEN** scheduling is `SILENT` and the `scheduling` key is removed from the result sent to Gemini

#### Scenario: End-of-conversation request
- **WHEN** a handler returns `{ ending: true, endConversation: "user said goodbye" }`
- **THEN** the result sent to Gemini is `{ ending: true }` and `endConversation` is `"user said goodbye"`

#### Scenario: Unknown tool
- **WHEN** `callTool` is invoked with a name that is not registered
- **THEN** the result is `{ error: "unknown tool <name>" }` with scheduling `INTERRUPT`

#### Scenario: Handler throws
- **WHEN** a handler throws or rejects
- **THEN** the result is `{ error: <message> }` with scheduling `INTERRUPT` so the model can tell the user

#### Scenario: Handler sees its conversation
- **WHEN** the model calls a tool in a chat turn of conversation `c1`
- **THEN** the handler's call context has channel `chat` and conversationId `c1`

#### Scenario: First voice exchange
- **WHEN** the model calls a tool in the first exchange of a voice session, before anything of it is stored
- **THEN** the handler's call context has channel `voice` and no conversationId

#### Scenario: Handler sees its device
- **WHEN** the model calls a tool in a voice session of device `friday-kitchen`
- **THEN** the handler's call context has channel `voice` and device `friday-kitchen`

#### Scenario: Talk page has no device
- **WHEN** the model calls a tool in a voice session opened by the portal's Talk page
- **THEN** the handler's call context has channel `voice` and no device

#### Scenario: No context given
- **WHEN** `callTool("get_current_time", {})` is invoked without options
- **THEN** the handler runs, and its call context has no channel, no conversationId and no device

#### Scenario: Handlers that ignore the context
- **WHEN** a tool's handler takes only its args
- **THEN** it behaves exactly as before
