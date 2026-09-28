# Spec Delta

## MODIFIED Requirements

### Requirement: Entries record turns and tool activity in order

A conversation SHALL hold an ordered list of entries. A **user** entry SHALL carry its text and its input kind: `speech` for transcribed audio, or `text` for typed input. An **assistant** entry SHALL carry its text, and SHALL be marked `interrupted` when it was cut off before it finished: when the user cut it off, or when a chat answer failed after part of it was streamed. A **tool** entry SHALL carry the tool name, its arguments and its result. Arguments and results larger than 4000 characters of JSON SHALL be truncated and marked as truncated. Each entry SHALL carry its time.

#### Scenario: Typed and spoken input are distinguished
- **WHEN** a user types "pause" on the Talk page and later says "play again"
- **THEN** the first user entry has input `text` and the second has input `speech`

#### Scenario: Tool activity is recorded
- **WHEN** the model calls `media_play` and it returns a result
- **THEN** a tool entry with name `media_play`, its arguments and its result appears between the user entry and the assistant entry that follow from it

#### Scenario: Oversized tool result
- **WHEN** a tool returns a result whose JSON is 20000 characters long
- **THEN** the stored result is cut to 4000 characters and marked truncated

#### Scenario: Chat answer cut off by a failure
- **WHEN** a chat answer fails after "Dune is" was streamed
- **THEN** an assistant entry "Dune is" marked interrupted is stored

### Requirement: Conversations API

`GET /api/conversations` SHALL list conversations, most recent activity first, with `id`, `channel`, `device`, `startedAt`, `lastActivityAt`, `endedAt`, `endReason`, `state` (`active` or `quiet`), `entryCount`, and a `preview` (the first user entry's text, up to 120 characters). It SHALL support `limit` (default 50), a `before` cursor for paging, and a `channel` filter (`voice` or `chat`); any other `channel` value SHALL respond 400. `GET /api/conversations/:id` SHALL return the conversation with all entries. `DELETE /api/conversations/:id` SHALL delete it and respond 204. It SHALL respond 409 while a voice session or a chat turn is still recording into that conversation. Unknown ids SHALL respond 404.

#### Scenario: Paging
- **WHEN** 120 conversations exist and the client requests the list twice, passing the first page's cursor as `before`
- **THEN** it receives the 50 most recent, then the next 50

#### Scenario: Delete a live conversation
- **WHEN** a DELETE targets a conversation whose voice session is still open
- **THEN** the response is 409 and the conversation is kept

#### Scenario: Delete during a chat turn
- **WHEN** a DELETE targets a chat conversation whose turn is still streaming
- **THEN** the response is 409 and the conversation is kept

#### Scenario: Only chat threads
- **WHEN** voice and chat conversations exist and the client requests `?channel=chat`
- **THEN** only chat conversations are listed, and paging with `before` keeps the filter

#### Scenario: Unknown channel
- **WHEN** the client requests `?channel=email`
- **THEN** the response is 400

### Requirement: Conversations page

The portal SHALL provide a `Conversations` page at `/conversations` with one table row per conversation: state dot, start time, channel, device, preview, entry count, and duration. The page SHALL load more rows on request. Clicking a row SHALL open a drawer showing the transcript in order: user entries marked as spoken or typed, assistant entries (with interruptions marked), and tool entries collapsed to their name and expandable to arguments and result. It SHALL also show the end reason and a `Delete` action that asks for confirmation. For a chat conversation, the drawer SHALL also offer `Open in Chat`, which navigates to `/chat/<id>`. `?id=` SHALL open the drawer for that conversation.

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
