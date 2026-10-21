# Spec Delta

## MODIFIED Requirements

### Requirement: Conversations are stored as transcript text only

Core SHALL store each conversation in `friday.db` with an id, a channel (`voice`, `chat` or `agent`), the device when known, start time, last-activity time, and, when it ended explicitly, the end time and end reason. Audio SHALL never be stored. A conversation SHALL be created on its first entry, so a session with no entries leaves no conversation behind.

#### Scenario: Voice conversation is stored
- **WHEN** a user asks Friday a question on `/ws/audio?device=kitchen` and the session ends
- **THEN** a conversation with channel `voice`, device `kitchen`, both turns as text, and its end reason is stored, and no audio is stored

#### Scenario: Nothing was said
- **WHEN** a session opens and closes without any transcript, typed text or tool call
- **THEN** no conversation is stored

#### Scenario: Agent run is stored
- **WHEN** an agent run calls one tool and answers
- **THEN** a conversation with channel `agent` holds the run's first message, the tool call and the answer

### Requirement: Conversations can be searched

The store SHALL search conversations with optional `query`, `since`, `until`, `channel`, `device`, `exclude` (conversation ids) and `limit` (default 5, at most 20).

- **Words**: `query` is split into words, and words of fewer than 3 characters are ignored. A word SHALL match any part of a word in an indexed entry, compared without case and accents. An entry matches when it contains at least one of the words.
- **Filters**: only entries whose time falls in `[since, until)` SHALL be considered. `channel` and `device` narrow the conversations. Conversations in `exclude` SHALL NOT be returned. Active and quiet conversations are both searched.
- **Ranking**: with words, a conversation matches when at least one of its entries matches. Conversations are ordered by the number of distinct words they match, then by most recent activity. Without words, every conversation with an entry in the window matches, most recent activity first.
- **Result**: each matched conversation SHALL carry its summary (as in the conversation listing) and up to 3 snippets. With words, a snippet is a matching entry together with the entry before and after it, and earlier snippets come first. Without words, the single snippet is the conversation's first 3 entries in the window. Snippet entries SHALL carry their kind, time and text, cut to 300 characters. Tool entries SHALL carry their name and arguments but never their result.

A `channel` other than `voice`, `chat` or `agent`, an invalid time, or a `since` later than `until` SHALL be refused with an invalid-query error.

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

#### Scenario: Only agent runs
- **WHEN** the search is for "review" with channel `agent`
- **THEN** only agent conversations mentioning "review" are returned

### Requirement: Conversations API

`GET /api/conversations` SHALL list conversations, most recent activity first, with `id`, `channel`, `device`, `startedAt`, `lastActivityAt`, `endedAt`, `endReason`, `state` (`active` or `quiet`), `entryCount`, and a `preview` (the first user entry's text, up to 120 characters). It SHALL support `limit` (default 50), a `before` cursor for paging, and a `channel` filter (`voice`, `chat` or `agent`); any other `channel` value SHALL respond 400. `GET /api/conversations/:id` SHALL return the conversation with all entries. `DELETE /api/conversations/:id` SHALL delete it and respond 204. It SHALL respond 409 while a voice session, a chat turn or an agent run is still recording into that conversation. Unknown ids SHALL respond 404.

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
