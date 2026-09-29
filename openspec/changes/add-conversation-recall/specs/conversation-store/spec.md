## ADDED Requirements

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
