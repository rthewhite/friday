# Tool Registry

## Purpose

A single in-process registry where native modules and MCP servers register tools. Declarations are sent to Gemini at session start; calls are dispatched by name. Every tool result carries a scheduling hint that controls how Gemini surfaces it.

## Requirements

### Requirement: Tools are registered with defineTool

A tool SHALL have a unique `name`, a `description`, either a Gemini `parameters` schema or a raw `parametersJsonSchema`, an optional default `scheduling`, and a sync or async `handler` returning an object.

#### Scenario: Register a tool
- **WHEN** a module calls `defineTool` with a new name
- **THEN** the tool is added to the registry and returned

#### Scenario: Duplicate name
- **WHEN** `defineTool` is called with a name already registered
- **THEN** it throws `duplicate tool <name>`

### Requirement: Declarations are produced for Gemini

`declarations()` SHALL return one Gemini function declaration per registered tool, using `parametersJsonSchema` when present and `parameters` otherwise.

#### Scenario: Native tool
- **WHEN** a tool defines `parameters`
- **THEN** its declaration contains `name`, `description`, `parameters`

#### Scenario: MCP tool
- **WHEN** a tool defines `parametersJsonSchema`
- **THEN** its declaration contains `name`, `description`, `parametersJsonSchema`

### Requirement: Calls are dispatched by name with scheduling resolution

`callTool` SHALL invoke the handler with the given args (empty object if none) and return `{ result, scheduling }`. Scheduling SHALL be resolved in order: a `scheduling` key in the handler's returned object (which is then stripped from the result), the tool's default `scheduling`, then `INTERRUPT`. Valid values are `INTERRUPT`, `WHEN_IDLE`, `SILENT`.

#### Scenario: Default scheduling
- **WHEN** a tool without `scheduling` returns a plain result
- **THEN** scheduling is `INTERRUPT`

#### Scenario: Tool-level default
- **WHEN** a tool declares `scheduling: "WHEN_IDLE"` and returns a plain result
- **THEN** scheduling is `WHEN_IDLE`

#### Scenario: Per-call override
- **WHEN** a handler returns `{ ..., scheduling: "SILENT" }`
- **THEN** scheduling is `SILENT` and the `scheduling` key is removed from the result sent to Gemini

#### Scenario: Unknown tool
- **WHEN** `callTool` is invoked with a name that is not registered
- **THEN** the result is `{ error: "unknown tool <name>" }` with scheduling `INTERRUPT`

#### Scenario: Handler throws
- **WHEN** a handler throws or rejects
- **THEN** the result is `{ error: <message> }` with scheduling `INTERRUPT` so the model can tell the user

### Requirement: Tool loading order

`loadTools()` SHALL import the builtin module, then the media module, then attach MCP servers.

#### Scenario: Load tools
- **WHEN** `loadTools()` runs
- **THEN** builtin, media and MCP tools are all registered before it resolves

### Requirement: Total tool count stays within Gemini limits

The project SHALL keep the total number of declared tools modest, since Gemini reads every declaration and caps at 512.

#### Scenario: Large MCP server
- **WHEN** an MCP server exposes many tools
- **THEN** operators use `include`/`exclude` in the MCP config to trim them
