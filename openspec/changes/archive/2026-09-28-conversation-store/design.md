# Design

## Context

`GeminiSession` (`packages/core/src/session.ts`) turns Gemini Live messages into transport events: `user_text` and `bot_text` fragments, `tool_call` and `tool_result`, `interrupted`, `turn_complete`, and exactly one `closed` with a reason. Typed input goes through `sendText` straight to Gemini and never appears as an event. `serveWs` creates one session per connection and already parses `?device=`. Core's `friday.db` has versioned migrations, and after `background-jobs` it also has a scheduler with `core` as a reserved owner. The portal chat that will later write `chat` conversations doesn't exist yet, and neither does its engine. See `proposal.md` for motivation and `specs/` for behaviour.

This change lands after `background-jobs`. The `portal-shell` delta assumes that change's `Jobs` nav item is already in the main spec.

## Goals / Non-Goals

**Goals:**
- One recording path for any engine: voice now, chat later, with nothing voice-specific in the store.
- Turn assembly that is deterministic and testable from recorded event sequences.
- Watermark-friendly reads, so the nightly brain job can process "everything quiet since last run" exactly once.

**Non-Goals:**
- Writing entries per streamed fragment. Durability is per turn, so a crash loses at most the turn in progress.
- Editing conversations. Entries are append-only. Deletion is per conversation.
- Search, export, per-person attribution.

## Decisions

### A store plus a per-conversation recorder, and the session drives the recorder
`packages/core/src/conversations/` holds:
- `ConversationStore`, over SQLite: create, append, mark quiet, list, get, delete, prune, plus the quiet sweep and the subscriber set.
- `ConversationRecorder`, one per live conversation: `user(text, input)`, `assistant(text)`, `tool(name, args)` (returns a handle for the result), `interrupted()`, `turnComplete()`, `end(reason)`, `resume(id)`. It owns fragment assembly and lazy creation.

`GeminiSession` gets an optional `recorder` in `SessionOptions`, and calls it right next to its existing `onEvent` calls, plus in `sendText`. That's the only place that sees typed input.

*Alternative:* the transport subscribes to session events and records them. Rejected, because typed text never becomes an event, and a future chat engine would need a different hook anyway. The recorder API is what the chat engine will call directly, with `resume(id)` to append to an existing thread.

### Turn assembly as a small state machine in the recorder
The recorder buffers `user`, `tool[]` and `assistant` for the current exchange:
- A user fragment while no assistant output has started is appended to the user buffer.
- The first assistant fragment or tool call flushes the user buffer as an entry.
- A user fragment *after* assistant output started is held as `pending`. On `interrupted`, the assistant buffer is flushed marked `interrupted`, and `pending` becomes the start of the next user buffer (a barge-in). On `turnComplete` without an interruption, `pending` is appended to the last user entry (a late fragment), and the assistant buffer is flushed.
- `recorder.tool(name, args)` reserves the entry's position at call time and returns a handle. `runTool` calls `handle.result(result)` when the tool settles, so concurrent calls to the same tool can't be mismatched. The entry is written once it has its result, or at `end()` with no result if the session closed first.
- `end(reason)` flushes everything and marks the conversation quiet with the reason.

Fragments are joined with the transcription's own spacing (no extra separators), then whitespace-trimmed. Unit tests replay captured Gemini fragment sequences, including barge-in and late fragments.

### Schema (migration 4)
```
conversations(id TEXT PK, channel TEXT, device TEXT, started_at TEXT, last_activity_at TEXT,
              ended_at TEXT, end_reason TEXT, quiet_at TEXT, entry_count INTEGER, preview TEXT)
  -- index (last_activity_at DESC), index (quiet_at)
conversation_entries(conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
              seq INTEGER, kind TEXT, input TEXT, text TEXT, interrupted INTEGER,
              tool_name TEXT, tool_args TEXT, tool_result TEXT, truncated INTEGER, at TEXT,
              PRIMARY KEY (conversation_id, seq))
```
`quiet_at IS NULL` means active. `preview` and `entry_count` are denormalised at append time, so the list query doesn't touch entries. Ids are `crypto.randomUUID()`. `foreign_keys = ON` is already set, so the cascade handles deletion.

### Quiet detection: explicit end plus a sweep timer, not a job
Voice conversations go quiet on `end()`. Threads that are left idle, or voice conversations orphaned by a crash, are caught by a sweep inside `ConversationStore` every 60 s: `quiet_at IS NULL AND last_activity_at < now - quietMinutes`. The sweep skips conversations that have a live recorder. Resuming sets `quiet_at = NULL`.

*Alternative:* a `core/conversation-quiet` job every minute. Rejected, because it would fill the Jobs page and its history with noise. Jobs are for meaningful work.

### Notifications are fire-and-forget. The watermark list is the contract
`onQuiet` handlers are called asynchronously after the quiet transaction commits, each in its own try/catch. There's no queue and no redelivery. `list({ quietSince })` returns `quiet_at > quietSince ORDER BY quiet_at ASC`, which gives a consumer exactly-once processing by storing its last `quiet_at` (e.g. in `ctx.storage`). A resumed conversation gets a new, later `quiet_at`, so it reappears to watermark consumers. That's the "becomes eligible again" behaviour the brain needs.

### Module context and hosts
`ModuleConversations` (the SDK types: `list`, `get`, `onQuiet`) is added to `ModuleContext`. `ModuleHost` receives `conversations?: (id) => ModuleConversations`, and its teardown drops that owner's subscriptions. `createContext`'s default throws `conversations are not available in this host`. The test host gets `MemoryConversations`, with `seed(conversation)` and `markQuiet(id)` helpers exposed as `host.conversations`.

### Retention is the first `core` job
`server.ts` registers `core/conversation-retention` with `cron: "0 4 * * *"` when `FRIDAY_CONVERSATION_RETENTION_DAYS > 0`. It deletes in batches of 500 inside transactions, checks the abort signal between batches, and returns `{ summary: "deleted N conversations" }`. The 04:00 slot leaves 03:00 free for the brain's nightly pass later.

### API and portal
Routes go in `createApp`: `GET /api/conversations` (cursor `before` = the `last_activity_at|id` of the last row, opaque to clients), `GET /api/conversations/:id`, and `DELETE /api/conversations/:id` (409 when a live recorder holds it). The portal gets `pages/ConversationsPage.vue` at `/conversations`, in the `Assistant` group with a `chat` icon (new in portal-ui), built from `DataTable` and `Drawer`, with a "Load more" footer. The transcript uses left/right aligned bubbles. User bubbles carry a small mic or keyboard marker, and tool entries are collapsible rows showing pretty-printed JSON.

## Risks / Trade-offs

- [Transcripts of anyone speaking near a Voice PE are kept for 90 days] → Text only, retention on by default, per-conversation delete in the portal, and `FRIDAY_CONVERSATION_RETENTION_DAYS` can be shortened. The README states what is stored.
- [Tool results may contain personal data, e.g. calendar or location] → They are capped at 4000 characters and fall under the same retention. Tools don't currently return secrets. If one ever does, it will need a redaction flag on the tool (a later change).
- [Gemini transcription ordering differs from what the assembly assumes] → The state machine is covered by replayed real sequences, and anomalies degrade to an extra short user entry rather than lost text.
- [Per-turn writes lose the turn in progress on a crash] → Accepted. The rest of the conversation is durable, and the sweep marks it quiet after restart.
- [Notifications are lost across restarts] → By design. The watermark list is the durable path, and the spec says so.

## Migration Plan

Migration 4 only creates tables. Rollback means deploying the previous image, which ignores them. New env vars (`FRIDAY_CONVERSATION_RETENTION_DAYS`, `FRIDAY_CONVERSATION_QUIET_MINUTES`) have defaults and are documented in `.env.example`. After the deploy, check the first stored voice conversation in the portal against what was said.

## Implementation notes

- **Entries are written when the exchange settles, not at the first assistant output.** The recorder keeps the current exchange in memory (user segments, then assistant text and tool calls in order) and writes it on `turnComplete`, `interrupted` or `end()`. A late user fragment then joins the question without rewriting a stored row, so entries stay append-only. A question that is transcribed entirely after the answer started is still placed first. Tool entries take their position in call order and are written once they are both placed and settled, or at `end()` without a result. Durability is still per turn, as the Non-Goals intend.
- **Typed text is never merged with speech.** Each typed message is its own user entry. Typed text that arrives during an answer starts the next exchange, and is not appended to the question.
- **Start time is the first entry's time.** The conversation row is created lazily at the first write, but `started_at` is the time of the earliest item in that exchange. `last_activity_at` is the time of the latest write.
- **An append clears the end.** Appending to a quiet conversation clears `quiet_at`, `ended_at` and `end_reason`, so a resumed thread that later goes idle has no stale end reason.
- **Live tracking lives in the store.** Recorders come from `store.recorder({ channel, device })` and `attach`/`detach` their conversation. The sweep, `prune` and `DELETE` (409) skip attached conversations.
- **API shape.** `GET /api/conversations` returns `{ conversations, next }`. `next` is an opaque base64url cursor, or `null` on the last page, and an invalid cursor answers 400. Summaries also carry `quietAt`, the field a watermark consumer stores.
- **Transport injection.** `createSession(onEvent, recorder?)` in `AudioWsOptions` receives the connection's recorder as a second argument, so injected sessions can drive it or ignore it.
- **Subscriptions per module.** `ModuleHost` wraps `ctx.conversations.onQuiet` and keeps each module's unsubscribers itself, dropping them on teardown and on a failed init. This works with any `conversations` factory, not only `store.forOwner`.
- **Test host.** `host.conversations.markQuiet(id, at?)` always fires, because it is an explicit test action. It awaits the handlers and returns the event.
- **Migration version.** This change uses version 4, because `background-jobs` owns version 3.
- **Retention (group 5) is implemented after `background-jobs` lands.** `store.prune(cutoff, 500)` deletes one batch in a transaction, skips live conversations and returns the count. The job loops on it and checks its abort signal between batches. The SDK README example nudges through a promise queue rather than `ctx.jobs.trigger`, which does not exist before that change. The job alternative is described in prose.
