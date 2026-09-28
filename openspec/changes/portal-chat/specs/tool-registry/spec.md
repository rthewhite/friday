# Spec Delta

## MODIFIED Requirements

### Requirement: Tools are registered with defineTool

A tool SHALL have a unique `name`, a `description`, either a Gemini `parameters` schema or a raw `parametersJsonSchema`, an optional default `scheduling`, an optional `channels` list, and a sync or async `handler` returning an object. `channels` SHALL name the conversation channels the tool is available in, a non-empty subset of `voice` and `chat`; a tool without `channels` SHALL be available in both. The registry SHALL be an instance created by core, and every registration SHALL record an `owner` string (a module id, or `mcp:<server>` for MCP servers). MCP and remote module tools SHALL be registered without `channels`.

#### Scenario: Register a tool
- **WHEN** `registry.add(owner, tool)` is called with a new name
- **THEN** the tool is added with that owner and returned

#### Scenario: Duplicate name
- **WHEN** `add` is called with a name already registered, regardless of owner
- **THEN** it throws `duplicate tool <name>`

#### Scenario: Invalid channels
- **WHEN** `add` is called with `channels: []` or a channel other than `voice` and `chat`
- **THEN** it throws `invalid channels for <name>` and the tool is not registered

#### Scenario: MCP tool channels
- **WHEN** an MCP server registers its tools
- **THEN** they are available in both `voice` and `chat`

### Requirement: Declarations are produced for Gemini

`declarations(channel?)` SHALL return one Gemini function declaration per registered tool, using `parametersJsonSchema` when present and `parameters` otherwise. When a channel is given, only tools available in that channel SHALL be included.

#### Scenario: Native tool
- **WHEN** a tool defines `parameters`
- **THEN** its declaration contains `name`, `description`, `parameters`

#### Scenario: MCP tool
- **WHEN** a tool defines `parametersJsonSchema`
- **THEN** its declaration contains `name`, `description`, `parametersJsonSchema`

#### Scenario: Narrowed to a channel
- **WHEN** `set_timer` has `channels: ["voice"]` and `get_current_time` has no `channels`
- **THEN** `declarations("chat")` contains only `get_current_time`, and `declarations("voice")` and `declarations()` contain both

### Requirement: Sessions snapshot declarations at open

Each voice session SHALL call `declarations("voice")` when it opens and use that snapshot for its lifetime. Tools added or removed later SHALL affect only sessions opened afterwards. A chat turn SHALL read `declarations("chat")` when it starts, so tools added or removed between messages take effect on the next message.

#### Scenario: Tool added mid-session
- **WHEN** a tool is registered while a session is open
- **THEN** the open session does not see it and the next session does

#### Scenario: Tool added between chat messages
- **WHEN** a tool is registered after a chat turn completed
- **THEN** the next turn on the same thread declares it

## ADDED Requirements

### Requirement: Calls can be restricted to a channel

`callTool` SHALL accept an optional channel. When a channel is given and the named tool is not available in it, the call SHALL NOT invoke the handler and SHALL return `{ error: "unknown tool <name>" }` with scheduling `INTERRUPT`, as for an unregistered name.

#### Scenario: Voice-only tool called from chat
- **WHEN** `callTool("set_timer", { seconds: 60 }, { channel: "chat" })` is invoked and `set_timer` is voice-only
- **THEN** no timer starts and the result is `{ error: "unknown tool set_timer" }`

#### Scenario: No channel given
- **WHEN** `callTool("set_timer", { seconds: 1 })` is invoked without a channel
- **THEN** the handler runs as before
