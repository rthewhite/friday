## ADDED Requirements

### Requirement: Declarations and calls respect module access

The registry SHALL be told how to decide whether a user may use a tool, given the tool's owner (the module that registered it), its name and the user. The rule is specified in `module-access`.
- **Declarations:** `declarations(channel, user?)` SHALL leave out every tool the user may not use.
- **Calls:** `callTool` SHALL refuse such a tool without invoking the handler, returning `{ error: "<name> isn't available to you" }` with scheduling `INTERRUPT`.
- **Order of checks:** the access check SHALL come after the channel and owner-only checks. A tool not offered in the channel stays an unknown tool, and an owner-only tool keeps its owner-only error.
- **Without a check:** a registry without an access check SHALL allow every tool.
- **Remote modules:** a remote module's runner SHALL allow every tool on its own side; core SHALL enforce access for remote tools.

#### Scenario: Restricted tool left out
- **WHEN** a chat turn for member `Sanne` builds its declarations and she may not use `HomeAssistant__restart_ha`
- **THEN** `HomeAssistant__restart_ha` is not among them and the other `HomeAssistant__*` tools are

#### Scenario: Restricted tool called anyway
- **WHEN** a call for `Sanne` names `HomeAssistant__restart_ha`
- **THEN** the handler is not invoked and the result is `{ error: "HomeAssistant__restart_ha isn't available to you" }`

#### Scenario: No access check
- **WHEN** the registry has no access check, as in a module's test host without the access option
- **THEN** every tool is offered as before
