# Conversation Store

## Purpose

Keeps a text record of every conversation with Friday, voice now and portal chat later, as resumable threads with a clear quiet lifecycle. The record is bounded by retention, browsable in the portal, and readable by modules for background work.

## Requirements

### Requirement: Conversations are stored as transcript text only

Core SHALL store each conversation in `friday.db` with an id, a channel (`voice` or `chat`), the device when known, start time, last-activity time, and, when it ended explicitly, the end time and end reason. Audio SHALL never be stored. A conversation SHALL be created on its first entry, so a session with no entries leaves no conversation behind.

#### Scenario: Voice conversation is stored
- **WHEN** a user asks Friday a question on `/ws/audio?device=kitchen` and the session ends
- **THEN** a conversation with channel `voice`, device `kitchen`, both turns as text, and its end reason is stored, and no audio is stored

#### Scenario: Nothing was said
- **WHEN** a session opens and closes without any transcript, typed text or tool call
- **THEN** no conversation is stored

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

### Requirement: Streaming transcripts are assembled into whole turns

Transcript fragments SHALL be joined into one entry per turn: consecutive fragments of the same role form one entry, and an entry is complete when the other role starts, a tool is called, the turn completes, or the conversation ends. A user fragment that arrives while the assistant is speaking SHALL start a new user entry after the interrupted assistant entry when an interruption follows it. When the turn completes without an interruption, the fragment SHALL be appended to the preceding user entry.

#### Scenario: One entry per spoken sentence
- **WHEN** the user's question arrives as five transcription fragments followed by the assistant's answer as eight fragments
- **THEN** the conversation holds one user entry and one assistant entry with the joined text

#### Scenario: Barge-in
- **WHEN** the user starts speaking while Friday answers and Gemini interrupts the answer
- **THEN** the answer is stored up to that point, marked `interrupted`, followed by a new user entry with what the user said

#### Scenario: Late transcription fragment
- **WHEN** the last fragment of the user's question arrives after the assistant has started answering, and the turn completes without interruption
- **THEN** the fragment is part of the user's entry, not a separate one

### Requirement: Conversations go quiet and can be resumed

A conversation SHALL be **active** while it receives entries, and SHALL become **quiet** when it ends explicitly, or when it has had no activity for `FRIDAY_CONVERSATION_QUIET_MINUTES` (default 30). A conversation SHALL remain resumable: an entry appended to a quiet conversation SHALL make it active again, and it SHALL go quiet again under the same rules. A conversation that was active when core stopped SHALL go quiet by the inactivity rule after restart.

#### Scenario: Voice conversation ends
- **WHEN** a voice session closes with `ended: no follow-up`
- **THEN** its conversation is quiet immediately, with that end reason

#### Scenario: Idle thread
- **WHEN** a chat conversation receives no entries for 30 minutes
- **THEN** it becomes quiet without an end reason

#### Scenario: Resumed thread
- **WHEN** a quiet conversation receives a new entry
- **THEN** it becomes active, its last-activity time moves forward, and it becomes quiet again later

### Requirement: Going quiet is announced

Each time a conversation becomes quiet, core SHALL notify subscribers with the conversation id, its last-activity time and the time it went quiet. The notification SHALL be best-effort and in-process. Durable catch-up SHALL be possible by listing conversations that went quiet after a given time, so a consumer that missed notifications, such as across a restart, loses nothing.

#### Scenario: Subscriber is notified
- **WHEN** a module subscribed to quiet conversations and a voice session ends
- **THEN** its handler receives that conversation's id and times

#### Scenario: Missed notification is recoverable
- **WHEN** a conversation went quiet while the consuming module was being reloaded
- **THEN** listing conversations quiet since the module's last watermark includes it

#### Scenario: Resumed and quiet again
- **WHEN** a conversation goes quiet, is resumed, and goes quiet again
- **THEN** subscribers are notified twice, the second time with the later last-activity time

### Requirement: Recording never breaks a conversation

A failure to store an entry or update a conversation SHALL be logged and SHALL NOT interrupt, delay or close the session that produced it.

#### Scenario: Storage fails mid-conversation
- **WHEN** writing an entry fails
- **THEN** the error is logged with the conversation id and the voice session continues normally

### Requirement: What was said is indexed for search

Core SHALL keep a full-text index of every stored conversation's user and assistant text, and of each tool entry's name and the values in its arguments. Argument keys and tool results SHALL NOT be indexed. Arguments cut short at 4000 characters are no longer JSON, and SHALL be indexed as their text. The index SHALL follow the record: an entry is searchable as soon as it is stored, and a conversation deleted through the API or by retention SHALL no longer be found. Conversations stored before the index existed SHALL be indexed when core upgrades, so they can be searched too. The index SHALL stay correct when the database is vacuumed.

#### Scenario: New entry is searchable
- **WHEN** a voice session records the user saying "is the boiler service booked?"
- **THEN** a search for "boiler" finds that conversation while the session is still open

#### Scenario: Tool arguments are indexed, results are not
- **WHEN** a conversation holds a `play_on_apple_tv` call with arguments `{ "title": "Dune" }` and a result mentioning "Arrival"
- **THEN** searches for "Dune" and for "apple" find it, and searches for "Arrival" and for "title" do not

#### Scenario: Vacuumed database
- **WHEN** the database is vacuumed after conversations were deleted
- **THEN** searches still return the right conversations, and deleting one afterwards removes only that conversation from the index

#### Scenario: Deleted conversation is gone from search
- **WHEN** a conversation that mentions "boiler" is deleted through `DELETE /api/conversations/:id`
- **THEN** a search for "boiler" no longer returns it

#### Scenario: Existing conversations after upgrade
- **WHEN** core starts on a database with conversations recorded before this change
- **THEN** those conversations can be searched

### Requirement: Conversations can be searched

The store SHALL search conversations with optional `query`, `since`, `until`, `channel`, `device`, `exclude` (conversation ids) and `limit` (default 5, at most 20).

- **Words**: `query` is split into words, and words of fewer than 3 characters are ignored. A word SHALL match any part of a word in an indexed entry, compared without case and accents. An entry matches when it contains at least one of the words.
- **Filters**: only entries whose time falls in `[since, until)` SHALL be considered. `channel` and `device` narrow the conversations. Conversations in `exclude` SHALL NOT be returned. Active and quiet conversations are both searched.
- **Ranking**: with words, a conversation matches when at least one of its entries matches. Conversations are ordered by the number of distinct words they match, then by most recent activity. Without words, every conversation with an entry in the window matches, most recent activity first.
- **Result**: each matched conversation SHALL carry its summary (as in the conversation listing) and up to 3 snippets. With words, a snippet is a matching entry together with the entry before and after it, and earlier snippets come first. Without words, the single snippet is the conversation's first 3 entries in the window. Snippet entries SHALL carry their kind, time and text, cut to 300 characters. Tool entries SHALL carry their name and arguments but never their result.

A `channel` other than `voice` or `chat`, an invalid time, or a `since` later than `until` SHALL be refused with an invalid-query error.

#### Scenario: Best match first
- **WHEN** conversation A mentions "boiler" and conversation B mentions "boiler" and "service", and the query is "boiler service"
- **THEN** B is returned before A

#### Scenario: Part of a word and accents
- **WHEN** a conversation says "de boilers in het café" and the query is "boiler cafe"
- **THEN** it is found

#### Scenario: Time window
- **WHEN** "boiler" was mentioned on 2026-09-01 and on 2026-09-20, and the search is for "boiler" since 2026-09-15
- **THEN** only the 2026-09-20 conversation is returned, and its snippets come from entries in the window

#### Scenario: Snippet context
- **WHEN** the matching entry is the assistant saying "The boiler service is on Tuesday"
- **THEN** the snippet holds the user entry before it, that entry, and the entry after it

#### Scenario: Window without words
- **WHEN** the search has only `since` and `until` spanning yesterday
- **THEN** yesterday's conversations are returned, most recent first, each with its first 3 entries of that day

#### Scenario: Excluded conversation
- **WHEN** the search excludes conversation C, and C is the only one mentioning "boiler"
- **THEN** no conversations are returned

#### Scenario: Invalid window
- **WHEN** `since` is later than `until`
- **THEN** the search is refused with an invalid-query error

### Requirement: Conversations are deleted after the retention period

Core SHALL register a daily job `core/conversation-retention` that deletes conversations, with their entries, whose last-activity time is older than `FRIDAY_CONVERSATION_RETENTION_DAYS` (default 90). The run's summary SHALL state how many were deleted. A value of 0 SHALL keep conversations forever, and the job SHALL then not be registered.

#### Scenario: Old conversation is removed
- **WHEN** the retention job runs and a conversation's last activity was 91 days ago
- **THEN** the conversation and its entries are deleted, and the run summary counts it

#### Scenario: Resumed thread is kept
- **WHEN** a thread was started 120 days ago but last resumed 10 days ago
- **THEN** it is kept

#### Scenario: Retention disabled
- **WHEN** `FRIDAY_CONVERSATION_RETENTION_DAYS=0`
- **THEN** no retention job is registered and nothing is deleted

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
