## ADDED Requirements

### Requirement: Prompt context respects module access

When a prompt is built for a user who may not use a module (as specified in `module-access`, `mode: chosen`), that module's prompt context providers SHALL NOT be called and their text SHALL NOT appear in the prompt. Restricted tools SHALL NOT affect prompt context: a module everyone may use keeps its prompt context for everyone. A prompt built without a user SHALL be built for the owner.

#### Scenario: Module not available
- **WHEN** a chat turn is built for member `Sanne` and the `travel` module is `mode: chosen` without her
- **THEN** the travel module's prompt context is not in her prompt, and it is in the owner's

### Requirement: Test host can apply module access

`createTestHost` SHALL accept an `access` option: a function given the user and, for a tool, the tool's name, that answers whether the user may use the module (no tool name) or that tool. With it, the test host's declarations and tool calls SHALL apply it per tool, and its prompt rendering per module, as core applies module access. Without it, everything SHALL be allowed, as before.

#### Scenario: Module test with access
- **WHEN** a test host is created with `access` denying `sonos_play` for user `u2`, and the test calls `sonos_play` as `u2`
- **THEN** the call returns the "isn't available to you" error and the handler isn't invoked
