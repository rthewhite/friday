## MODIFIED Requirements

### Requirement: Conversations in the context

`ModuleContext` SHALL include `conversations` for in-process modules, with read-only access to the conversation store:
- `list({ quietSince?, limit? })`: without `quietSince`, the most recently active conversations first. With `quietSince`, the conversations currently quiet that went quiet after that time, oldest first, so a consumer can advance a watermark.
- `get(id)`: one conversation with all its entries, or `undefined`.
- `search({ query?, since?, until?, channel?, device?, exclude?, limit? })`: the conversation store's search, with times as ISO 8601 instants, returning matched conversations with their snippets. An invalid query SHALL reject with an error stating what is invalid.
- `onQuiet(handler)`: subscribe to quiet notifications.

A handler that throws SHALL be logged with the module id and SHALL NOT affect other subscribers. Subscriptions SHALL be removed when the module is disposed or reloaded. Hosts without a conversation store, such as the remote runner, SHALL make these calls fail with an error stating that conversations are not available in that host. The test host SHALL provide an in-memory store that tests can seed with conversations, and on which tests can mark a conversation quiet to fire `onQuiet` handlers. Its `search` SHALL apply the same word, filter, ranking and snippet rules as the conversation store.

#### Scenario: Watermark processing
- **WHEN** a module calls `list({ quietSince: "2026-10-01T03:00:00Z" })`
- **THEN** it receives the conversations that went quiet after that time, oldest first

#### Scenario: Subscriptions follow the lifecycle
- **WHEN** a module with an `onQuiet` handler is reloaded
- **THEN** the old handler no longer fires and the handler registered by the new `init` does

#### Scenario: Test host
- **WHEN** a test seeds a conversation and marks it quiet
- **THEN** the module's `onQuiet` handler runs and `ctx.conversations.get(id)` returns the seeded entries

#### Scenario: Module searches conversations
- **WHEN** a module calls `search({ query: "boiler", since: "2026-09-15T00:00:00Z" })`
- **THEN** it receives the conversations mentioning "boiler" in entries since that time, best match first, with snippets

#### Scenario: Test host search
- **WHEN** a test seeds two conversations, only one mentioning "boiler", and the module calls `search({ query: "boiler" })`
- **THEN** only that conversation is returned, with a snippet around the matching entry

#### Scenario: Search in a remote host
- **WHEN** a module running through the remote runner calls `search`
- **THEN** the call fails with an error stating that conversations are not available in that host
