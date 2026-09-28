# Tasks

## 1. Store and schema

- [x] 1.1 Add migration 4 (`conversations` with indexes on `last_activity_at DESC` and `quiet_at`, and `conversation_entries` with an `ON DELETE CASCADE` FK) to `packages/core/src/storage/db.ts`, and verify `storage.test.ts` applies it on a fresh and on a version-3 database
- [x] 1.2 Implement `ConversationStore` in `packages/core/src/conversations/store.ts`: create, append entries (updating `last_activity_at`, `entry_count` and `preview`, and clearing `quiet_at` on resume), mark quiet, get, list (recent-first with a `before` cursor, and `quietSince` oldest-first), delete, and batch prune. Truncate tool args and results at 4000 characters with a `truncated` flag. Verify with `packages/core/test/conversations-store.test.ts` covering paging, the watermark order, resume moving `quiet_at` forward, cascade delete, and truncation
- [x] 1.3 Add the quiet sweep (every 60 s, skipping conversations with a live recorder, using an injected clock) and the `onQuiet` subscriber set (async after commit, per-handler try/catch). Verify with tests: an idle chat conversation goes quiet after the quiet period, a live one doesn't, a throwing subscriber doesn't block others, and resume-then-quiet notifies twice
- [x] 1.4 Add `conversationRetentionDays` and `conversationQuietMinutes` to core `settings`, and document `FRIDAY_CONVERSATION_RETENTION_DAYS` and `FRIDAY_CONVERSATION_QUIET_MINUTES` in `.env.example`. Verify the defaults (90, 30) with a unit test

## 2. Recorder and turn assembly

- [x] 2.1 Implement `ConversationRecorder` in `packages/core/src/conversations/recorder.ts`: lazy creation on the first entry, `user(text, input)`, `assistant(text)`, `tool(name, args)` returning a result handle, `interrupted()`, `turnComplete()`, `end(reason)`, `resume(id)`, and every store error caught and logged with the conversation id. Verify with recorder unit tests for lazy creation (no entries means no row), the end reason, and a failing store not throwing
- [x] 2.2 Implement the assembly state machine (fragments joined per role, pending user fragments during assistant output becoming a barge-in on `interrupted` or appended on `turnComplete`, tool entries placed at call time). Verify with replayed fragment sequences: a normal exchange, barge-in, a late user fragment, a tool call mid-turn, and two concurrent calls to the same tool

## 3. Session and transport integration

- [x] 3.1 Add an optional `recorder` to `SessionOptions` and call it from `handle` (input/output transcription, `interrupted`, `turnComplete`), `sendText` (input `text`), `runTool` (handle around the call), and `emitClosed` (`end(reason)`). Verify `session.test.ts` cases: typed text is recorded as `text`, `end_conversation` gives end reason `ended: done`, and emitted events are identical with and without a recorder
- [x] 3.2 In `serveWs`, create a recorder per connection with channel `voice` and the `device` query value, and pass it to the default `GeminiSession`. Keep `createSession` injection working. Verify `ws.test.ts` records `device=kitchen`, and records no device without the parameter
- [x] 3.3 Wire the store into `server.ts` (created after the database, sweep started, sweep stopped on shutdown, passed to `attachAudioWs` and `createApp`), and verify by talking to a local core and seeing the conversation row with entries in `friday.db`

## 4. Module access

- [x] 4.1 Add `ModuleConversations` types to `@friday/sdk`, add `conversations` to `ModuleContext` and `createContext` (default throws `conversations are not available in this host`), and export the types. Verify a remote-runner test that `ctx.conversations.list()` rejects with that message
- [x] 4.2 Pass `conversations: (id) => store.forOwner(id)` from `ModuleHost`, and drop that owner's `onQuiet` subscriptions on teardown and init failure. Verify `reload.test.ts`: after a reload the old handler doesn't fire and the new one does
- [x] 4.3 Add `MemoryConversations` to the test host (`host.conversations.seed(...)`, `host.conversations.markQuiet(id)`), and verify with test-host tests that `onQuiet` fires and `get` returns seeded entries
- [x] 4.4 Document `ctx.conversations` (the watermark pattern with `ctx.storage`, and triggering a job from `onQuiet`) in `packages/sdk/README.md`, and verify the example compiles by using it in a test

## 5. Retention

- [ ] 5.1 Register `core/conversation-retention` (`0 4 * * *`) in `server.ts` when retention is above 0: batch deletes of 500 checking the abort signal, returning `{ summary: "deleted N conversations" }`. Verify with a job test using a fake clock (a 91-day-old conversation deleted, a thread resumed 10 days ago kept) and a test that retention 0 registers no job

## 6. Conversations API

- [x] 6.1 Add `GET /api/conversations` (limit, `before` cursor), `GET /api/conversations/:id`, and `DELETE /api/conversations/:id` (204, 404, and 409 while a recorder is live) to `createApp`. Verify with `platform-api.test.ts` cases for the summary shape, paging over 120 rows, full entries, 404, and 409 during a live session
- [x] 6.2 Add a README section on conversations (what is stored, text only, retention, deleting, the env vars), and verify its `curl` examples against a local core

## 7. Portal Conversations page

- [x] 7.1 Add a `chat` icon to `@friday/portal-ui` `Icon.vue`, and verify it renders in the component test
- [x] 7.2 Add the `/conversations` route and a `Conversations` item after `Talk` in the `Assistant` group, and verify the sidebar order: Talk, Conversations
- [x] 7.3 Build `pages/ConversationsPage.vue`: a table (state dot, start with `formatDateTime`, channel, device, preview, entry count, duration), "Load more" using the cursor, and a drawer with the ordered transcript (spoken or typed markers, interrupted marker, collapsible tool entries with pretty JSON), the end reason, and `Delete` with confirmation. `?id=` opens the drawer. Verify `pnpm --filter @friday/portal build` passes and the page works against a local core with a recorded conversation, including delete

## 8. Integration

- [x] 8.1 Run `pnpm test` and `pnpm -r typecheck` across the workspace, and verify both pass
- [ ] 8.2 Deploy to the homelab and verify: a Voice PE conversation appears with its device, spoken turns and tool activity; a barge-in shows an interrupted answer followed by the user's words; typing on the Talk page records `text` input; and the Jobs page lists `core/conversation-retention` with its next run at 04:00
