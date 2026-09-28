# Proposal

## Why

In the portal, Friday can only be spoken to. Typing is often quicker, quieter and more precise (names, links, lists), and some questions deserve a longer written answer. The conversation store was built with a `chat` channel and resumable threads for exactly this, so the portal chat can now be added: typed threads you can return to later, unlike voice conversations, which are one-shot.

## What Changes

- New **chat engine** in core, separate from Gemini Live: every message is one turn against a non-Live text model with function calling. The turn loads the thread's whole history from the conversation store, replays past tool entries as function call/response pairs, runs a tool loop against the registry, and records the turn into the same conversation with channel `chat`.
- The chat model is `FRIDAY_CHAT_MODEL`, falling back to `FRIDAY_TEXT_MODEL`. Chat model calls share the existing text-model concurrency bound and retry policy.
- New API `POST /api/chat`: a message, optionally with the id of an existing chat conversation. It answers with a **server-sent event stream**: thought summaries, text deltas, tool calls and tool results as they happen, then `done` or `error`. A new thread is created by its first message. A second message on a thread with a running turn gets 409. A turn keeps running and is recorded if the browser disconnects.
- Tool definitions get an optional **`channels`** flag (`voice`, `chat`; default both). Chat only offers tools available in `chat`; voice sessions only offer tools available in `voice`. `end_conversation` and `set_timer` become voice-only. Chat tool calls are bounded by `FRIDAY_CHAT_TOOL_TIMEOUT_MS` (default 30000).
- The **system prompt** is split into a shared base and a part per channel. Voice keeps its current instructions; chat allows markdown and complete answers.
- New portal **Chat page** at `/chat` and `/chat/:id` under `Assistant`: a list of chat threads, a streaming transcript with markdown (raw HTML disabled), dimmed thought summaries, collapsible tool activity, and a message input. The `Conversations` page offers `Open in Chat` on chat conversations.
- `GET /api/conversations` gains a `channel` filter.

Out of scope: token-budget windows or summaries of long threads, timers that report back into a chat, a stop-generation button, continuing voice conversations in chat, generated thread titles, and chat outside the portal (messaging apps).

## Capabilities

### New Capabilities
- `portal-chat`: the chat engine (history replay, tool loop, recording), `POST /api/chat` and its event stream, and the portal `Chat` page.

### Modified Capabilities
- `tool-registry`: tools declare the channels they are available in, and `declarations()` can be narrowed to one channel.
- `builtin-tools`: `set_timer` and `end_conversation` are voice-only.
- `voice-session`: a session declares only tools available in `voice`, and the system prompt is the shared base plus the voice part.
- `conversation-store`: the list API filters by channel; an assistant entry is also marked interrupted when a chat answer was cut off by a failure; the Conversations page offers `Open in Chat` for chat conversations.
- `module-llm`: the concurrency bound covers chat model calls as well as module calls.
- `portal-shell`: the `Assistant` section contains `Talk`, `Chat` and `Conversations`.

## Impact

- **SDK**: `Tool` gains `channels`; `ToolRegistry.declarations(channel?)` and a channel check in the chat path (`packages/sdk/src/{tool,registry}.ts`).
- **Core**: new `packages/core/src/chat/` (engine, history replay, SSE route); `llm/gemini.ts` gains a streaming call with tools and thought summaries; `llm/service.ts` exposes its concurrency slot and pre-output retries to the chat engine; `conversations/recorder.ts` gets a way to finish a turn without marking the conversation quiet; `conversations/store.ts` and `app.ts` get the channel filter and the chat route; `config.ts` gets the prompt split and the new settings; `session.ts` declares voice tools only.
- **Modules**: `modules/builtin` marks `set_timer` and `end_conversation` as voice-only.
- **Portal**: new `pages/ChatPage.vue` with a streaming composable, routes and nav item, `Open in Chat` on `ConversationsPage.vue`, a markdown renderer dependency (e.g. `markdown-it`) with HTML disabled.
- **Docs**: README (chat, what is stored), `.env.example` (`FRIDAY_CHAT_MODEL`, `FRIDAY_CHAT_TOOL_TIMEOUT_MS`), `openspec/config.yaml` context.
- **Security**: a new write endpoint that runs tools. It is covered by the existing cross-origin write refusal, and model output is rendered without raw HTML. `/security-review` applies.
