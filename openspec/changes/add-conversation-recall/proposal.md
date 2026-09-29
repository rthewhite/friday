# Proposal

## Why

Friday records every conversation, but it can't look back at them. "What was that film we talked about last week?" or "what did I ask you yesterday about the boiler?" gets no answer unless the nightly brain pass happened to distil it into a page. The brain keeps distilled facts; the raw record is the only place for what was actually said, and today only the portal and the nightly job can read it, by scanning whole transcripts.

## What Changes

- The conversation store keeps a full-text index over what was said: user and assistant text, and the name and argument values of each tool call (not argument keys or tool results). The index follows inserts, deletes and retention, and is built for existing conversations by the migration.
- The store can search conversations by words and by a time window, channel and device, returning the best-matching conversations with short snippets around each match. Without words, it returns the conversations in the window with their opening turns.
- `ctx.conversations` gains `search(...)` for in-process modules. The test host's in-memory conversations support it.
- Tool handlers receive a second argument with the call's context: its channel and, when known, the id of the conversation the call is made in. Existing handlers that take only `args` keep working.
- The brain module adds a tool `brain_recall_conversations` (voice and chat) that searches past conversations and never returns the conversation the call is made in. Its description sets it apart from `brain_recall`: pages hold what Friday knows, conversations hold what was said.

Out of scope: a search box on the portal's Conversations page and a search HTTP endpoint (a follow-up can reuse the same index), and any change to retention or to what is recorded.

## Capabilities

### New Capabilities
<!-- None -->

### Modified Capabilities
- `conversation-store`: conversations are indexed and searchable by words, time window, channel and device, with snippets.
- `module-system`: `ctx.conversations` gains `search`, and the test host supports it.
- `tool-registry`: tool handlers receive the call's channel and conversation id, which voice sessions and chat turns pass to `callTool`.
- `brain`: new tool `brain_recall_conversations`.

## Impact

- Code: `packages/core/src/storage/db.ts` (migration 6: FTS5 table and triggers, backfill), `packages/core/src/conversations/store.ts` (search, module read access), `packages/core/src/session.ts` and `packages/core/src/chat/engine.ts` (pass the conversation id to `callTool`), `packages/sdk/src/{conversations,tool,registry}.ts`, `modules/brain/src/` (new tool).
- Tests: `packages/core/test/` conversation store and migration tests, `packages/sdk/test/` registry and memory conversations, `modules/brain/test/`.
- Tool count: one new tool.
- No API removals, no new configuration. `node:sqlite` on Node 24 ships FTS5, including the `trigram` tokenizer, so there is no new dependency.
- In flight: none.
