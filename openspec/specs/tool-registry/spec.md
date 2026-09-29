# Tool Registry

## Purpose

A single in-process registry where native modules and MCP servers register tools. Declarations are sent to Gemini at session start; calls are dispatched by name. Every tool result carries a scheduling hint that controls how Gemini surfaces it.

## Requirements

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

### Requirement: Calls are dispatched by name with scheduling resolution

`callTool` SHALL invoke the handler with the given args (empty object if none) and a call context, and return `{ result, scheduling, endConversation? }`. The call context SHALL carry the `channel` and `conversationId` passed in `callTool`'s options, each absent when not given. A voice session SHALL pass channel `voice` and a chat turn SHALL pass channel `chat`, each with the id of the conversation the call is recorded in once that conversation is stored, and without one before. Tools served by MCP servers and remote modules SHALL NOT receive the call context. Scheduling SHALL be resolved in order: a `scheduling` key in the handler's returned object (which is then stripped from the result), the tool's default `scheduling`, then `INTERRUPT`. Valid values are `INTERRUPT`, `WHEN_IDLE`, `SILENT`. If the handler's returned object has a string `endConversation` key, it SHALL be stripped from the result and returned as `endConversation`.

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

#### Scenario: No context given
- **WHEN** `callTool("get_current_time", {})` is invoked without options
- **THEN** the handler runs, and its call context has no channel and no conversationId

#### Scenario: Handlers that ignore the context
- **WHEN** a tool's handler takes only its args
- **THEN** it behaves exactly as before

### Requirement: Total tool count stays within Gemini limits

The project SHALL keep the total number of declared tools modest, since Gemini reads every declaration and caps at 512.

#### Scenario: Large MCP server
- **WHEN** an MCP server exposes many tools
- **THEN** operators use `include`/`exclude` in the MCP config to trim them

### Requirement: Tools can be removed by owner

`removeOwner(owner)` SHALL unregister every tool with that owner and return the number removed.

#### Scenario: Remove an MCP server's tools
- **WHEN** `removeOwner("mcp:home")` is called after that server registered three tools
- **THEN** it returns 3 and none of them are in `declarations()`

### Requirement: Registry changes are observable

`onChange(listener)` SHALL register a listener called after any add or removal and return an unsubscribe function.

#### Scenario: Listener fires
- **WHEN** a tool is added and then its owner removed
- **THEN** the listener is called twice; after unsubscribing, further changes do not call it

### Requirement: Sessions snapshot declarations at open

Each voice session SHALL call `declarations("voice")` when it opens and use that snapshot for its lifetime. Tools added or removed later SHALL affect only sessions opened afterwards. A chat turn SHALL read `declarations("chat")` when it starts, so tools added or removed between messages take effect on the next message.

#### Scenario: Tool added mid-session
- **WHEN** a tool is registered while a session is open
- **THEN** the open session does not see it and the next session does

#### Scenario: Tool added between chat messages
- **WHEN** a tool is registered after a chat turn completed
- **THEN** the next turn on the same thread declares it

### Requirement: Registry lists tools with owners

`list()` SHALL return `{ name, owner, description }` for every registered tool, for `/api/modules` and startup logging.

#### Scenario: Startup log
- **WHEN** the server starts
- **THEN** it logs each loaded module with its tool names

### Requirement: Calls can be restricted to a channel

`callTool` SHALL accept an optional channel. When a channel is given and the named tool is not available in it, the call SHALL NOT invoke the handler and SHALL return `{ error: "unknown tool <name>" }` with scheduling `INTERRUPT`, as for an unregistered name.

#### Scenario: Voice-only tool called from chat
- **WHEN** `callTool("set_timer", { seconds: 60 }, { channel: "chat" })` is invoked and `set_timer` is voice-only
- **THEN** no timer starts and the result is `{ error: "unknown tool set_timer" }`

#### Scenario: No channel given
- **WHEN** `callTool("set_timer", { seconds: 1 })` is invoked without a channel
- **THEN** the handler runs as before
