## ADDED Requirements

### Requirement: Conversations are read per user

Every way of reading conversations SHALL be scoped to one user: listing, reading one, searching, deleting and module access (`ctx.conversations.forUser`). A conversation of another user SHALL behave as if it doesn't exist: listing and searching leave it out, and reading or deleting it SHALL respond 404. The retention job SHALL still apply to every conversation.

#### Scenario: Two users' threads
- **WHEN** the owner and member `Sanne` each have a chat thread and Sanne lists conversations
- **THEN** only her thread is listed, and the owner's thread id answers 404 for her

## MODIFIED Requirements

### Requirement: Conversations API

`GET /api/conversations` SHALL list the requesting user's conversations, most recent activity first, with `id`, `channel`, `device`, `startedAt`, `lastActivityAt`, `endedAt`, `endReason`, `state` (`active` or `quiet`), `entryCount`, and a `preview` (the first user entry's text, up to 120 characters). It SHALL support `limit` (default 50), a `before` cursor for paging, and a `channel` filter (`voice`, `chat` or `agent`); any other `channel` value SHALL respond 400. `GET /api/conversations/:id` SHALL return the user's conversation with all entries. `DELETE /api/conversations/:id` SHALL delete the user's conversation and respond 204. It SHALL respond 409 while a voice session, a chat turn or an agent run is still recording into that conversation. Unknown ids, and ids of another user's conversations, SHALL respond 404.

#### Scenario: Paging
- **WHEN** 120 conversations exist and the client requests the list twice, passing the first page's cursor as `before`
- **THEN** it receives the 50 most recent, then the next 50

#### Scenario: Delete a live conversation
- **WHEN** a DELETE targets a conversation whose voice session is still open
- **THEN** the response is 409 and the conversation is kept

#### Scenario: Delete during a chat turn
- **WHEN** a DELETE targets a chat conversation whose turn is still streaming
- **THEN** the response is 409 and the conversation is kept

#### Scenario: Delete during an agent run
- **WHEN** a DELETE targets the conversation of an agent run that is still running
- **THEN** the response is 409 and the conversation is kept

#### Scenario: Only chat threads
- **WHEN** voice and chat conversations exist and the client requests `?channel=chat`
- **THEN** only chat conversations are listed, and paging with `before` keeps the filter

#### Scenario: Unknown channel
- **WHEN** the client requests `?channel=email`
- **THEN** the response is 400

#### Scenario: Another user's conversation
- **WHEN** member `Sanne` requests or deletes the id of the owner's conversation
- **THEN** the response is 404 and the conversation is unchanged

### Requirement: Conversations page

The portal SHALL provide a `Conversations` page at `/conversations` with one table row per conversation of the logged-in user: state dot, start time, channel, device, preview, entry count, and duration. For a conversation whose device is registered (as specified in `voice-devices`), the device SHALL be shown by its label, with its id available on hover; other devices SHALL be shown by their id. The page SHALL load more rows on request. Clicking a row SHALL open a drawer showing the transcript in order: user entries marked as spoken or typed, assistant entries (with interruptions marked), and tool entries collapsed to their name and expandable to arguments and result. It SHALL also show the device as in the table, the end reason and a `Delete` action that asks for confirmation. For a chat conversation, the drawer SHALL also offer `Open in Chat`, which navigates to `/chat/<id>`. `?id=` SHALL open the drawer for that conversation.

#### Scenario: Read a conversation
- **WHEN** the user opens a voice conversation that used a tool
- **THEN** the drawer shows the spoken question, the collapsed tool entry, and the answer, in order

#### Scenario: Delete
- **WHEN** the user deletes a conversation and confirms
- **THEN** it disappears from the list and `GET /api/conversations/:id` responds 404

#### Scenario: Open a chat thread
- **WHEN** the user opens a chat conversation's drawer and chooses `Open in Chat`
- **THEN** the portal shows `/chat/<id>` with that thread ready for a new message

#### Scenario: Voice conversations cannot be continued
- **WHEN** the user opens a voice conversation's drawer
- **THEN** no `Open in Chat` action is shown

#### Scenario: Registered device shown by label
- **WHEN** a conversation was recorded from device `friday-kitchen`, registered with label `Kitchen satellite`
- **THEN** its row and drawer show `Kitchen satellite`, and hovering shows `friday-kitchen`

#### Scenario: Unregistered device
- **WHEN** a conversation was recorded from a device id that is no longer registered
- **THEN** its row shows the id

### Requirement: Conversations record their user

A conversation SHALL record the user it belongs to: the user of a chat thread, the user of a browser voice session, the owner for a voice device's session (as specified in `data-ownership`), and the agent's creator for an agent run. Conversations stored before users existed SHALL be assigned to the household owner. A chat thread SHALL keep the user who started it, also when it is continued later. `GET /api/conversations` and `GET /api/conversations/:id` SHALL include `user` (`{ id, name }`, or `null`). Listing, reading, searching and deleting SHALL be limited to the requesting user's conversations.

#### Scenario: Chat
- **WHEN** member `u2` starts a chat thread
- **THEN** the conversation records user `u2`, and the API lists it with `user: { id: "u2", name }`

#### Scenario: Voice device
- **WHEN** device `friday-kitchen` holds a conversation
- **THEN** the conversation belongs to the household owner

#### Scenario: Not filtered
- **WHEN** members `u1` and `u2` each have a chat thread older than the retention period and the retention job runs
- **THEN** both threads are deleted: retention is not limited by user

#### Scenario: Filtered
- **WHEN** members `u1` and `u2` each have a chat thread and `u1` lists conversations
- **THEN** only `u1`'s thread is listed
