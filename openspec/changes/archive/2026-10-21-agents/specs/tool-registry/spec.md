# Spec Delta

## MODIFIED Requirements

### Requirement: Tools are registered with defineTool

A tool SHALL have a unique `name`, a `description`, either a Gemini `parameters` schema or a raw `parametersJsonSchema`, an optional default `scheduling`, an optional `channels` list, and a sync or async `handler` returning an object. `channels` SHALL name the conversation channels the tool is available in, a non-empty subset of `voice`, `chat` and `agent`; a tool without `channels` SHALL be available in all three. The registry SHALL be an instance created by core, and every registration SHALL record an `owner` string (a module id, or `mcp:<server>` for MCP servers). Remote module tools SHALL be registered without `channels`. MCP tools SHALL be registered with their server's `channels` when the server sets them, and without `channels` otherwise.

#### Scenario: Register a tool
- **WHEN** `registry.add(owner, tool)` is called with a new name
- **THEN** the tool is added with that owner and returned

#### Scenario: Duplicate name
- **WHEN** `add` is called with a name already registered, regardless of owner
- **THEN** it throws `duplicate tool <name>`

#### Scenario: Invalid channels
- **WHEN** `add` is called with `channels: []` or a channel other than `voice`, `chat` and `agent`
- **THEN** it throws `invalid channels for <name>` and the tool is not registered

#### Scenario: MCP tool channels
- **WHEN** an MCP server without `channels` registers its tools
- **THEN** they are available in `voice`, `chat` and `agent`

#### Scenario: Agent-only MCP server
- **WHEN** an MCP server with `channels: ["agent"]` registers its tools
- **THEN** they are available in `agent` only, and absent from `declarations("voice")` and `declarations("chat")`

## ADDED Requirements

### Requirement: A tool can be removed by name

`remove(name)` SHALL unregister the tool with that name, whatever its owner, notify change listeners when it removed one, and return whether it did.

#### Scenario: Rebuild one tool
- **WHEN** `remove("run_agent")` is called while `run_agent` and core's alert tools are registered
- **THEN** only `run_agent` is removed and listeners are notified once

#### Scenario: Unknown name
- **WHEN** `remove("nothing")` is called
- **THEN** it returns false and listeners are not notified
