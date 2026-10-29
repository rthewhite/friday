## ADDED Requirements

### Requirement: Test host fakes users and the owner

`createTestHost` SHALL accept `users` (a list of `{ id, name }`) and `owner` (one of them, or an id) options, served through `ctx.users`. Without `owner`, the test host's `user` option SHALL be the owner, and without that a fixed test owner SHALL be used. Without `users`, the list SHALL hold the owner and the `user`. Calls without a user SHALL count as the owner's in the test host, so modules with owner-only tools stay testable without setting a user. The test host SHALL offer a way to record the owner later, which fires `onOwner` handlers.

#### Scenario: Owner recorded later
- **WHEN** a test creates a host without an owner and then records owner `u1`
- **THEN** the module's `onOwner` handler runs with `u1`

## MODIFIED Requirements

### Requirement: Conversations in the context

`ModuleContext` SHALL include `conversations` for in-process modules, with read-only access to the conversation store, one user at a time. `forUser(id)` SHALL return a view of that user's conversations only:
- `list({ quietSince?, limit? })`: without `quietSince`, the most recently active conversations first. With `quietSince`, the conversations currently quiet that went quiet after that time, oldest first, so a consumer can advance a watermark.
- `get(id)`: one of the user's conversations with all its entries, or `undefined` (also for another user's conversation).
- `search({ query?, since?, until?, channel?, device?, exclude?, limit? })`: the conversation store's search, with times as ISO 8601 instants, returning matched conversations with their snippets. An invalid query SHALL reject with an error stating what is invalid.
`ctx.conversations` itself SHALL offer only `forUser(id)` and `onQuiet(handler)`, which subscribes to quiet notifications that carry the conversation's user id. There SHALL be no unscoped `list`, `get` or `search`.

A handler that throws SHALL be logged with the module id and SHALL NOT affect other subscribers. Subscriptions SHALL be removed when the module is disposed or reloaded. Hosts without a conversation store, such as the remote runner, SHALL make these calls fail with an error stating that conversations are not available in that host. The test host SHALL provide an in-memory store that tests can seed with conversations, and on which tests can mark a conversation quiet to fire `onQuiet` handlers. Its `search` SHALL apply the same word, filter, ranking and snippet rules as the conversation store.

#### Scenario: Watermark processing
- **WHEN** a module calls `forUser("u1").list({ quietSince: "2026-10-01T03:00:00Z" })`
- **THEN** it receives `u1`'s conversations that went quiet after that time, oldest first

#### Scenario: Subscriptions follow the lifecycle
- **WHEN** a module with an `onQuiet` handler is reloaded
- **THEN** the old handler no longer fires and the handler registered by the new `init` does

#### Scenario: Test host
- **WHEN** a test seeds a conversation and marks it quiet
- **THEN** the module's `onQuiet` handler runs with the conversation's user id, and `ctx.conversations.forUser(<that user>).get(id)` returns the seeded entries

#### Scenario: Module searches conversations
- **WHEN** a module calls `forUser("u1").search({ query: "boiler", since: "2026-09-15T00:00:00Z" })`
- **THEN** it receives `u1`'s conversations mentioning "boiler" in entries since that time, best match first, with snippets, and none of another user's

#### Scenario: Test host search
- **WHEN** a test seeds two conversations of the same user, only one mentioning "boiler", and the module searches that user's conversations for "boiler"
- **THEN** only that conversation is returned, with a snippet around the matching entry

#### Scenario: Search in a remote host
- **WHEN** a module running through the remote runner calls `forUser(id).search`
- **THEN** the call fails with an error stating that conversations are not available in that host

### Requirement: Prompt context sees the current user

The info a prompt context provider receives SHALL carry `user`: `{ id, name }`, when the prompt is built for a user. That is a chat turn, a voice session opened by a browser, and a voice device's session, which is built for the household owner (as specified in `data-ownership`). It SHALL be absent only while no owner is recorded. Existing providers that read only `channel` SHALL behave as before.

#### Scenario: Chat turn
- **WHEN** a member starts a chat turn
- **THEN** each provider receives `{ channel: "chat", user: { id, name } }` for that member

#### Scenario: Voice device
- **WHEN** a voice device opens a session
- **THEN** each provider receives `{ channel: "voice", user }` with the household owner
