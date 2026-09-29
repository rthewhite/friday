# Design

## Context

See proposal.md (Why) and the delta specs for the behaviour. The code as it stands:

- **Entries are insert-only.** `ConversationStore.append` is the only writer of `conversation_entries`. A tool entry is written once, with its args and result together, after the tool settled (the recorder holds it until then). Entries leave only through `DELETE FROM conversations` (API and retention), cascading via the foreign key.
- **`conversation_entries` is keyed `(conversation_id, seq)`**, with only an implicit `rowid`. SQLite doesn't promise that an implicit rowid survives `VACUUM`, so it can't be the index key (D1).
- **Voice sessions write late.** The voice recorder holds the current exchange (question, tool calls, answer) and writes it when the turn completes or is interrupted. When the model calls a tool in the first exchange of a session, the conversation doesn't exist yet and `recorder.conversationId` is `undefined`. Chat calls `commitUser()` before the model answers, so a chat turn always has an id.
- **`callTool(name, args, { channel })`** calls `handler(args)`. Voice (`session.ts`) and chat (`chat/engine.ts`) each call `recorder.tool(...)` just before `callTool`. MCP and remote tools are registered with handlers that forward only args.
- **The brain module already has the word rules** (`searchTerms` in `modules/brain/src/search.ts`: folding, stopwords, 8 words) and reads `ctx.conversations` in the nightly pass.
- **Timezone handling:** `@friday/sdk`'s `time.ts` has `localDate` (instant to local date) but no local-date-to-instant helper. `modules/travel/src/helpers.ts` has a private `zoneOffsetMinutes`.
- **Environment:** Node 24 ships SQLite 3.51 with FTS5. The `trigram` tokenizer with `remove_diacritics 1` works: `cafe` matches `café`, and `BOILER` matches `boilers`.

## Goals / Non-Goals

**Goals:**
- The search index can't drift from the record: it is maintained by SQLite triggers, not by application code.
- One implementation of the ranking and snippet rules, shared by core and the test host, so a brain test against `MemoryConversations` means the same thing as a run against `friday.db`.
- Household-sized performance: 90 days of retention, a few thousand entries. A search runs in well under the voice tool latency budget.

**Non-Goals:**
- Relevance tuning beyond "distinct words, then recency". No BM25 weighting, stemming or synonyms.
- Phrase search. A multi-word query ranks conversations that contain more of the words higher, which is enough for "Band of Brothers".
- Exposing search over HTTP or in the portal (see proposal.md).

## Decisions

### D1. A contentless FTS5 table keyed by an explicit entry id, maintained by triggers

Migration 6 (`conversation-search`) first rebuilds `conversation_entries` with an explicit `id INTEGER PRIMARY KEY`. `(conversation_id, seq)` stays unique, and the foreign key and cascade stay as they were. It copies the rows in `(conversation_id, seq)` order and swaps the tables with create, copy, drop and rename. No table references entries, and the store never reads rowids, so nothing else changes. Then it creates:

```
conversation_search  USING fts5(body, content='', contentless_delete=1,
                                tokenize='trigram remove_diacritics 1')
```

- **Row mapping:** each index row's rowid is the `id` of its `conversation_entries` row. An `INTEGER PRIMARY KEY` is the one rowid SQLite keeps across `VACUUM` (and `VACUUM INTO`, a common way to back up).
- **What `body` holds:** `text` for user and assistant entries. For tool entries, `tool_name` plus the string and number values in `tool_args`, taken with `json_tree` and without keys, so `title` or `query` don't match every call that has such a key. Arguments cut at 4000 characters aren't valid JSON any more (`json_valid`), so they go in as text. `tool_result` is never included. `searchableText` in the SDK builds the same text for the test host.
- **Triggers:** `AFTER INSERT` adds the row. `AFTER DELETE` removes it (SQLite fires delete triggers for rows removed by `ON DELETE CASCADE`). An `AFTER UPDATE OF kind, text, tool_name, tool_args` trigger (delete then insert) is included, even though nothing updates entries today, so a future writer can't make the index drift. It is limited to the indexed columns so an update elsewhere doesn't re-index.
- **Backfill:** the same migration fills the index for existing rows with `INSERT INTO conversation_search(rowid, body) SELECT id, <body expr> FROM conversation_entries`. It runs in the migration's transaction.

Why contentless: the text already lives in `conversation_entries`. Search looks up matching ids and reads the entries themselves, and snippets are built from whole neighbouring entries, so FTS5's `snippet()` and `highlight()` (unavailable on contentless tables) aren't needed.

*Alternatives:*
- *External-content table (`content='conversation_entries'`):* needs a real column holding the combined body, which would mean a generated column or a view, and complicates the delete triggers (they must supply old values).
- *A regular FTS table with `UNINDEXED` conversation_id, seq and at columns:* duplicates the text and is no simpler to query.
- *Scanning with `LIKE` and no index:* works at today's volume but doesn't handle accents without folding every row per query, and grows linearly.

### D2. Trigram tokenizer, words of 3+ characters

`trigram` gives "matches part of a word" for free. That suits noisy speech transcripts ("boilers" vs "boiler") and Dutch compounds ("cv-ketel", "ketelonderhoud"). Its limit is that a term shorter than 3 characters can't match, which is why the spec drops those words.

*Alternative:* `unicode61 remove_diacritics 2` with prefix queries (`boiler*`). This is prefix-only, so "onderhoud" would never find "ketelonderhoud".

### D3. One MATCH per word, then ranking and snippets in shared TypeScript

The store splits `query` into words using the SDK rule (D4). For each word it runs one query that joins `conversation_search` to `conversation_entries` and `conversations`:

- The word goes into `MATCH` as a double-quoted FTS string with embedded quotes doubled, so user text is never parsed as FTS syntax.
- The query applies the `at` window, `channel`, `device` and `exclude` filters.
- It is grouped per conversation, returning one row per conversation with its matching seqs (`group_concat`), so a common word costs one row per conversation rather than one per entry.

There are at most 8 words from the brain tool, and a household corpus. The store then:

1. **Ranks** conversations with `compareMatches` from `@friday/sdk`: by the number of distinct words hit, then by `last_activity_at DESC, id DESC`. It keeps `limit`.
2. **Loads** the in-window entries for those conversations only, in one query per conversation, without `tool_result`, which snippets never carry.
3. **Builds** each conversation's snippets with `snippetsFor(entries, matchingSeqs)` from `@friday/sdk`. `MemoryConversations` calls the same two functions.

With no words, step 1 is "conversations with any entry in the window, most recent first", and the snippet is the first 3 in-window entries.

The rules `snippetsFor` applies:
- **Snippet shape:** each snippet is a matching entry plus its in-window neighbours.
- **Overlaps:** a matching entry already shown in an earlier snippet doesn't start a new one, so adjacent matches don't repeat text.
- **Count:** at most 3 snippets.
- **Cutting:** entry text is cut to 300 characters, and tool args are cut to 300 characters of JSON. When cut, the args are returned as the cut JSON text, as the store already does for truncated tool JSON.

*Alternative:* one `MATCH "a" OR "b"` query. This can't tell which words each row matched, so distinct-word ranking would need a second pass anyway.

### D4. Shared search primitives live in `@friday/sdk`

`packages/sdk/src/conversation-search.ts` exports:
- **The types:** `SearchConversationsOptions`, `ConversationMatch` (a summary plus `snippets: SnippetEntry[][]`) and `SnippetEntry`. `SnippetEntry` is a user or assistant entry with `text`, or a tool entry with `name` and `args`, and never has `result`.
- **The word rule:** `queryWords(query)` splits on non-letter and non-digit characters, keeps words of 3+ characters, and removes duplicates after folding.
- **Ranking and snippets:** `compareMatches` (the ranking comparator) and `snippetsFor`. There are also the helpers both stores need to find hits the same way: `foldSearchText`, `searchableText` (what the index holds for an entry) and `inWindow`.
- **Validation:** `validateSearch(opts)`, which covers the channel, parseable instants, `since <= until`, and limit clamping (default 5, 1 to 20). Both stores use it, so core and the test host refuse the same inputs. Core converts its failure to `InvalidQuery`, and `forOwner` exposes it as a rejected promise.

`MemoryConversations.search` finds hits by substring on text folded as NFD, with combining marks stripped and lower-cased. On household text this behaves the same as trigram matching.

The SDK stays dependency-free, and none of this is imported by `@friday/sdk/remote`'s host. The remote host's `conversations.search` fails like its other methods, through the existing `noConversations` helper.

### D5. The call context is a second handler argument, filled from the recorder

- **Types:** `Tool.handler` becomes `(args: A, call: ToolCallContext) => ...`, with `ToolCallContext = { channel?: ConversationChannel; conversationId?: string }`. `CallOptions` gains `conversationId`, and `callTool` passes `{ channel, conversationId }`. Existing one-parameter handlers are type-compatible and unaffected.
- **Voice:** `session.ts` passes `this.opts.recorder?.conversationId` after `recorder.tool(...)`.
- **Chat:** `engine.ts` passes the thread's id.
- **MCP and remote:** their handlers keep ignoring the second argument, so the context never crosses to an external server.

**The first voice exchange has no id.** Nothing of the current exchange is stored yet, so it can't be found and there's nothing to exclude. Earlier exchanges of the same session were written at their turn end, so the id exists for them. This meets the brain spec ("the conversation the call is made in SHALL always be excluded").

*Alternatives:*
- *Forcing `commitUser()` in voice before a tool call:* changes when voice entries are written and their order, which the conversation-store spec defines.
- *Excluding all active conversations:* hides a chat thread from ten minutes ago, which is exactly the case users will ask about.

### D6. The brain tool: date handling and result size

- **Registration:** it is registered next to `brain_recall` in `modules/brain/src/tools.ts` and reads the zone through the module's existing `householdTimeZone` getter.
- **Dates:** a strict `^\d{4}-\d{2}-\d{2}$` check, plus a round-trip check that rejects `2026-02-30`.
  - `since` maps to the local midnight at the start of that day.
  - `until` maps to the local midnight at the start of the next day, the exclusive end. A next day that isn't a date (after `9999-12-31`) is the same date error.
  - Both use a new `@friday/sdk` helper, `startOfLocalDay(date, zone): Date | undefined`, that handles DST (23- and 25-hour days, and a midnight skipped by DST) and returns `undefined` for anything that isn't a real calendar date, so it also serves as the tool's date check.
  - The travel module's private `zoneOffsetMinutes` isn't refactored in this change.
- **Words:** `searchTerms(query)` from `search.ts`, joined with spaces, becomes the store `query`. A non-blank `query` that leaves no terms ("TV", "what did we") is an `{ error }` asking for longer words. Otherwise it would silently become a date-only search, and the model would present the latest conversations as matches.
- **Result shape:** `{ found, conversations: [{ id, channel, device?, started: "YYYY-MM-DD HH:mm", snippets: [[{ who: "user" | "friday" | "tool", text? , tool?, args? }]] }] }`.
  - It is serialised and checked against 8000 characters, dropping from the end (lowest rank) until it fits. The best match is never dropped. When it alone is too long, its later snippets are dropped instead. One snippet is at most 3 entries of 300 characters, so it always fits, even with JSON escapes.
  - When nothing matched, the result is `{ found: 0, message }`.
- **Description:** "What was said in earlier conversations (voice and chat): use for 'what did we talk about…', 'what did I ask…', 'what did we watch…'. For facts about people, places and projects use brain_recall. Dates are YYYY-MM-DD in the household's time zone; call get_current_time first for relative dates like 'last week'."

## Risks / Trade-offs

- [The trigram index is roughly 3x the size of the text] → Transcripts are small and retention caps them at 90 days by default. At a few MB of text this is noise next to the WAL.
- [Per-word queries scale with the number of words] → The brain tool caps at 8 words. The store doesn't cap, but callers are in-process modules only.
- [Speech transcripts are noisy, so a misheard word won't be found] → Part-of-word matching absorbs inflections. Misheard names remain a limit; the tool description suggests trying other words.
- [Search results bring old conversation text back into a live prompt] → Tool results are never indexed or returned (the same stance as the nightly pass), and snippets are bounded to 3 per conversation, 300 characters per entry and 8000 characters overall. The text was said in this household, so no new exposure is created.
- [The backfill and the entries table rebuild run inside the boot migration] → A household database copies and indexes in well under a second. It is one transaction, so a failure rolls back and aborts boot with the migration name, as for every migration.
- [Words in a tool's name match every call to it: "time" finds each `get_current_time` call] → Accepted. Names help ("what did we play on the Apple TV"), and a conversation that only matches on a name ranks below one that also matches what was said, once there are two words.
- [The model passes relative dates ("last week")] → The spec'd error names the expected format. The description tells the model to resolve dates with `get_current_time`, which is always registered by `builtin`.
- [The migration number is claimed at merge time] → 6 is free on `main` today. If another change lands a 6 first, renumber during the rebase (per the working agreements).

## Migration Plan

- **Deploy:** migration 6 applies at boot and backfills. There is no configuration to add.
- **Rollback:** an older image won't recognise schema version 6. Migrations are forward-only here, as for 1 to 5. Rolling back means restoring the PVC snapshot, or running `DROP TABLE conversation_search` plus the triggers and setting `schema_version` to 5 by hand. The index holds no data of its own, so dropping it loses nothing. The rebuilt entries table keeps every column the older code writes, and its new `id` fills itself in, so the older code keeps working with it.
