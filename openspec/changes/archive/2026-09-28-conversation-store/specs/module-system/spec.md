# Spec Delta

## ADDED Requirements

### Requirement: Conversations in the context

`ModuleContext` SHALL include `conversations` for in-process modules, with read-only access to the conversation store:
- `list({ quietSince?, limit? })`: without `quietSince`, the most recently active conversations first. With `quietSince`, the conversations currently quiet that went quiet after that time, oldest first, so a consumer can advance a watermark.
- `get(id)`: one conversation with all its entries, or `undefined`.
- `onQuiet(handler)`: subscribe to quiet notifications.

A handler that throws SHALL be logged with the module id and SHALL NOT affect other subscribers. Subscriptions SHALL be removed when the module is disposed or reloaded. Hosts without a conversation store, such as the remote runner, SHALL make these calls fail with an error stating that conversations are not available in that host. The test host SHALL provide an in-memory store that tests can seed with conversations, and on which tests can mark a conversation quiet to fire `onQuiet` handlers.

#### Scenario: Watermark processing
- **WHEN** a module calls `list({ quietSince: "2026-10-01T03:00:00Z" })`
- **THEN** it receives the conversations that went quiet after that time, oldest first

#### Scenario: Subscriptions follow the lifecycle
- **WHEN** a module with an `onQuiet` handler is reloaded
- **THEN** the old handler no longer fires and the handler registered by the new `init` does

#### Scenario: Test host
- **WHEN** a test seeds a conversation and marks it quiet
- **THEN** the module's `onQuiet` handler runs and `ctx.conversations.get(id)` returns the seeded entries
