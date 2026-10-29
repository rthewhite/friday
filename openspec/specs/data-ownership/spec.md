# Data Ownership

## Purpose

Decides which user a piece of personal data belongs to, so that what one person says to Friday and what Friday remembers for them stays theirs. It covers the household owner as the fallback, voice devices acting for the owner, admins not seeing other users' data, the users modules can see, and tools only the owner may use.

## Requirements

### Requirement: Personal data belongs to one user

Conversations, brain pages and their history, agents, agent runs and their actions SHALL each belong to exactly one user. Data written for a user (a chat turn, a browser voice session, a portal edit, an agent created or run by them) SHALL belong to that user. Data written without a user SHALL belong to the household owner (as specified in `user-auth`). No API, page, tool, prompt or job SHALL give one user the content of another user's data. This SHALL hold for admins too: the admin role governs the household's setup (configuration, devices, keys, users), not other users' content.

#### Scenario: Member's chat stays theirs
- **WHEN** member `Sanne` chats with Friday and the owner later lists conversations, searches them through Friday, or reads the brain
- **THEN** none of it shows Sanne's conversation or anything the nightly pass learned from it

#### Scenario: Admin can't look in
- **WHEN** an admin requests another user's conversation, brain page or agent by id
- **THEN** the response is 404

### Requirement: Voice devices act for the owner

A session of a registered voice device SHALL be held for the household owner: its prompt context SHALL be built for the owner, its tool calls SHALL carry the owner as user, and its conversation SHALL belong to the owner. When no owner is recorded yet, the session SHALL have no user, as before.

#### Scenario: Kitchen device
- **WHEN** someone talks to device `friday-kitchen` and the owner is `Raymond`
- **THEN** the prompt holds Raymond's brain, tool calls carry Raymond, and the conversation is in Raymond's history

### Requirement: Existing data goes to the owner

Data stored before it had a user (conversations, agents and agent runs without a user, and the brain's pages, runs, names and tombstones) SHALL be assigned to the household owner. Core SHALL assign its own data at startup when an owner is recorded, and right after the first owner is recorded. Modules SHALL be able to do the same for their data through `ctx.users`. Assigning SHALL only change data without a user and SHALL be safe to repeat. Without auth configured, the dev user SHALL stand in for the owner.

#### Scenario: Upgrade with an owner
- **WHEN** Friday starts on a database whose conversations, agents and brain have no user and the owner `Raymond` is recorded
- **THEN** all of them belong to Raymond

#### Scenario: Fresh install
- **WHEN** a fresh install has no owner yet and the first admin then logs in
- **THEN** the data written so far, such as the brain's initial profile, is assigned to that admin right after their login

### Requirement: Modules can see the users

`ModuleContext` SHALL include `users` for in-process modules:
- `owner()`: the household owner as `{ id, name }`, or `undefined` while none is recorded;
- `list()`: every user who is not disabled, as `{ id, name }`;
- `onOwner(handler)`: called once when the owner is first recorded; it returns a function that unsubscribes, and subscriptions end when the module is disposed or reloaded.

No email, subject or token SHALL be exposed. Hosts without users, such as the remote runner, SHALL make these calls fail with an error stating that users are not available in that host.

#### Scenario: Nightly over users
- **WHEN** the owner and member `Sanne` exist and Sanne is enabled
- **THEN** `ctx.users.list()` returns both, and `ctx.users.owner()` returns the owner

### Requirement: Tools can be for the owner only

A tool SHALL be able to declare `ownerOnly: true`. Such a tool SHALL be left out of the declarations of a chat turn, a voice session and an agent run whose user is not the household owner. A call to it for any other user, or without a user, SHALL NOT run the handler and SHALL return an error saying the tool is only available to the household owner.

#### Scenario: Member asks for the owner's agenda
- **WHEN** member `Sanne` asks in chat "what's on my calendar today?"
- **THEN** her chat turn offers no calendar tools, and Friday can't read the owner's calendar for her

#### Scenario: Forced call
- **WHEN** an owner-only tool is called with a member's call context
- **THEN** the handler doesn't run and the result is the owner-only error

### Requirement: The limit of privacy is documented

The README SHALL state that privacy holds inside Friday only: whoever operates the server can read `friday.db`.

#### Scenario: Docs
- **WHEN** someone reads the README's section on users
- **THEN** it says that the operator can read every user's data in `friday.db`
