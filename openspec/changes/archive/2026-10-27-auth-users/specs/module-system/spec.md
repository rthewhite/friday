## ADDED Requirements

### Requirement: Module routes see the current user

A module route handler's request SHALL carry `user`: `{ id, name, role }` of the user who made the request (`role` is `admin` or `member`). Because every `/api/` request is checked before routing (as specified in `http-server`), `user` SHALL always be set for a module route served by core. A module that needs an admin SHALL check `req.user.role` itself. The user SHALL NOT include an email, a subject or any token.

#### Scenario: Member calls a module route
- **WHEN** member `u2` named `Sanne` requests `GET /api/modules/brain/pages`
- **THEN** the handler's `req.user` is `{ id: "u2", name: "Sanne", role: "member" }`

#### Scenario: Dev user
- **WHEN** authentication is not configured and the local machine calls a module route
- **THEN** the handler's `req.user` is the dev user with role `admin`

### Requirement: Prompt context sees the current user

The info a prompt context provider receives SHALL carry `user`: `{ id, name }`, when the prompt is built for a user. That is a chat turn, or a voice session opened by a browser. It SHALL be absent for a voice session of a voice device. Existing providers that read only `channel` SHALL behave as before.

#### Scenario: Chat turn
- **WHEN** a member starts a chat turn
- **THEN** each provider receives `{ channel: "chat", user: { id, name } }` for that member

#### Scenario: Voice device
- **WHEN** a voice device opens a session
- **THEN** each provider receives `{ channel: "voice" }` without `user`

### Requirement: Test host sets the current user

`createTestHost` SHALL accept a `user` option (`{ id, name, role }`) that is passed as `req.user` to route requests, as `user` (`{ id, name }`) in the call context of tool calls, and as `user` to prompt context providers when the test host renders prompt context. Each call and request SHALL be able to override or omit it. Without the option, route requests SHALL carry a test user with role `admin`, and calls and prompts SHALL carry no user.

#### Scenario: Route as a member
- **WHEN** a test host is created with `user: { id: "u2", name: "Sanne", role: "member" }` and calls a module route
- **THEN** the handler sees that user as `req.user`

#### Scenario: Tool call without a user
- **WHEN** a test calls a tool with the user omitted for that call
- **THEN** the handler's call context has no `user`
