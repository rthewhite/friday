# Proposal

## Why

Everything said to Friday is gone when the session closes: transcripts go to the client and are at most logged. Keeping the transcripts enables a conversation history in the portal, and gives background work something to read. The first reader will be a nightly brain job that extracts durable facts. A portal chat is also planned, whose threads are resumed over days, so the store has to be designed for more than voice now rather than migrated later. Depends on `background-jobs` for retention and for jobs that react to finished conversations.

## What Changes

- Core records conversations in `friday.db`, **transcript text only, never audio**. A conversation records a channel (`voice` now, `chat` later), the device when known, start and last-activity times, and an end reason when it has one.
- Turns are stored in order: role (`user` | `assistant`), text, and how the input arrived (`speech`, which is Gemini transcription and noisy, or `text`, which is typed and exact). Tool calls and their results are stored as well, with results size-capped. Streaming transcript chunks are assembled into whole turns, and an interrupted assistant turn is marked as interrupted.
- Recording is independent of the engine and the transport. Core gets a conversation recorder that any conversation writes into: `GeminiSession` on `/ws/audio` now, a portal chat engine later. The `device` query parameter on `/ws/audio` is stored with the conversation instead of being ignored.
- **Conversations are resumable threads.** A conversation can receive new turns after it went quiet. A voice conversation is simply one that is never resumed.
- A conversation is **quiet** once it has ended explicitly, or has had no activity for a configured period. When a conversation goes quiet, an event carries its id and last-activity time. A resumed conversation that goes quiet again fires again. The event is a best-effort notification. The durable way to catch up is listing the conversations that went quiet since a watermark, which is what a nightly job does.
- Modules get read access, `ctx.conversations`: list conversations (e.g. those quiet since a time), read one in full, and subscribe to the quiet event (`onQuiet`). A module that wants a job to run when a conversation goes quiet calls `ctx.jobs.trigger` from that handler. Remote modules do not get `ctx.conversations`.
- A conversation is created on its first entry, so a session in which nothing was said or answered (such as a false wake) leaves nothing behind.
- Retention: conversations whose last activity is older than `FRIDAY_CONVERSATION_RETENTION_DAYS` (default 90, 0 keeps them forever) are deleted by a nightly core job.
- HTTP API to list, read and delete conversations. Portal: a `Conversations` page under `Assistant` listing conversations (channel, device, time, first line) with a drawer showing the transcript and tool activity, and a delete action.
- Recording never breaks a conversation. A storage failure is logged and the voice session carries on.

Out of scope: the portal chat itself, user identity (a conversation carries a device, not a person), full-text search over transcripts, and export.

## Capabilities

### New Capabilities
- `conversation-store`: the conversation and turn model, the recorder, the quiet lifecycle and its event, retention, `ctx.conversations`, the conversations API and the `Conversations` page.

### Modified Capabilities
- `voice-session`: a session records its conversation, meaning its turns (with input kind), its tool calls and results, and its end reason.
- `audio-transport`: the `device` query parameter is recorded with the conversation rather than only logged.
- `module-system`: `ModuleContext` gains `conversations` for in-process modules, and the test host provides an in-memory one.
- `portal-shell`: the `Assistant` section gains `Conversations` after `Talk`.

## Impact

- `packages/core`: a recorder (e.g. `src/conversations/`), a migration adding conversation and turn tables, hooks in `session.ts` and `transports/ws.ts`, the retention job (the first real `core` job), `/api/conversations` routes.
- `packages/sdk`: `ModuleContext.conversations` types, the test host.
- `packages/portal`: a `Conversations` page and nav entry.
- Data: transcripts from shared rooms are now kept for up to 90 days on the data PVC. New env vars for retention and the quiet period, documented in `.env.example`.
