## ADDED Requirements

### Requirement: brain_recall_conversations searches what was said

The module SHALL register a tool `brain_recall_conversations`, offered in both channels, with optional parameters `query`, `since` and `until` (dates as `YYYY-MM-DD`), and `channel` (`voice` or `chat`). Its description SHALL tell the model to use it for what was said in earlier conversations, and to use `brain_recall` for what Friday knows about people, places and projects.

The tool SHALL search conversations through `ctx.conversations.search`:
- **Words**: the significant words of `query`, by the same rules as `brain_recall` (short words and English and Dutch stopwords dropped, at most 8 words). A non-blank `query` with no significant words SHALL return an error saying so and suggesting longer words, rather than being searched as if no query were given.
- **Dates**: read as whole days in the household time zone, both inclusive. `since` is the start of its day and `until` is the end of its day.
- **Current conversation**: the conversation the call is made in, taken from the call context, SHALL always be excluded.
- **Size**: at most 5 conversations.

With no parameters, it SHALL return the most recent conversations.

Each returned conversation SHALL carry its id, its channel, its device when known, its start as a local date and time in the household time zone, and its snippets. Snippet entries SHALL be marked as the user, Friday, or a tool call with its name and arguments. Tool results SHALL never be included. The result's JSON SHALL be at most 8000 characters: when it would be longer, the lowest-ranked conversations SHALL be dropped until it fits. The best match SHALL always be kept: when it alone is too long, its later snippets SHALL be dropped instead. When nothing matches, the result SHALL say so and state the searched dates, if any. An invalid date, or a `since` later than `until`, SHALL return an error naming the problem, so the model can ask again.

#### Scenario: Recall last week's film
- **WHEN** a chat conversation on 2026-09-22 discussed the film "Arrival", and on 2026-09-29 the user asks by voice "what was that film we talked about last week?" and the model calls `brain_recall_conversations({ query: "film", since: "2026-09-21", until: "2026-09-27" })`
- **THEN** the result includes the 2026-09-22 conversation with a snippet containing "Arrival", and its start in local time

#### Scenario: The current conversation is left out
- **WHEN** the user asks "what did we say about the boiler?" and only the current conversation mentions "boiler"
- **THEN** the result says no conversations matched

#### Scenario: Yesterday without words
- **WHEN** the model calls `brain_recall_conversations({ since: "2026-09-28", until: "2026-09-28" })`
- **THEN** the result holds the conversations with entries on 2026-09-28 in the household time zone, most recent first, each with its opening turns

#### Scenario: Played media is found through tool arguments
- **WHEN** a voice conversation called `play_on_apple_tv` for "Band of Brothers" and the model searches for "Band of Brothers"
- **THEN** the result includes that conversation with the tool call's name and arguments, and without its result

#### Scenario: Large result is cut
- **WHEN** five conversations match and their snippets together exceed 8000 characters of JSON
- **THEN** the lowest-ranked conversations are dropped until the result fits

#### Scenario: The best match alone is too long
- **WHEN** the best-matching conversation's snippets alone exceed 8000 characters of JSON
- **THEN** the result holds that conversation with its later snippets dropped, not "nothing matched"

#### Scenario: Invalid date
- **WHEN** the model calls `brain_recall_conversations({ since: "last week" })`
- **THEN** the result is an error stating that `since` must be a date as `YYYY-MM-DD`

#### Scenario: No searchable words
- **WHEN** the model calls `brain_recall_conversations({ query: "TV" })`
- **THEN** the result is an error stating that the query has no searchable words, and no conversations are returned
