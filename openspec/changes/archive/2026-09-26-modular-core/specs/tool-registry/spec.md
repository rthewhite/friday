# Spec Delta

## MODIFIED Requirements

### Requirement: Tools are registered with defineTool

A tool SHALL have a unique `name`, a `description`, either a Gemini `parameters` schema or a raw `parametersJsonSchema`, an optional default `scheduling`, and a sync or async `handler` returning an object. The registry SHALL be an instance created by core, and every registration SHALL record an `owner` string (a module id, or `mcp:<server>` for MCP servers).

#### Scenario: Register a tool
- **WHEN** `registry.add(owner, tool)` is called with a new name
- **THEN** the tool is added with that owner and returned

#### Scenario: Duplicate name
- **WHEN** `add` is called with a name already registered, regardless of owner
- **THEN** it throws `duplicate tool <name>`

### Requirement: Calls are dispatched by name with scheduling resolution

`callTool` SHALL invoke the handler with the given args (empty object if none) and return `{ result, scheduling, endConversation? }`. Scheduling SHALL be resolved in order: a `scheduling` key in the handler's returned object (which is then stripped from the result), the tool's default `scheduling`, then `INTERRUPT`. Valid values are `INTERRUPT`, `WHEN_IDLE`, `SILENT`. If the handler's returned object has a string `endConversation` key, it SHALL be stripped from the result and returned as `endConversation`.

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

## ADDED Requirements

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

Each voice session SHALL call `declarations()` when it opens and use that snapshot for its lifetime. Tools added or removed later SHALL affect only sessions opened afterwards.

#### Scenario: Tool added mid-session
- **WHEN** a tool is registered while a session is open
- **THEN** the open session does not see it and the next session does

### Requirement: Registry lists tools with owners

`list()` SHALL return `{ name, owner, description }` for every registered tool, for `/api/modules` and startup logging.

#### Scenario: Startup log
- **WHEN** the server starts
- **THEN** it logs each loaded module with its tool names

## REMOVED Requirements

### Requirement: Tool loading order
**Reason**: Tools are no longer loaded by a fixed builtin → media → MCP import sequence; the module host loads modules from core's list and MCP servers are attached as a separate tool source.
**Migration**: Add tools inside a module's `init(ctx)` via `ctx.defineTool`; register the module in core's module list.
