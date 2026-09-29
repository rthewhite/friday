# Design

## Context

See `proposal.md` for motivation and `specs/` for behaviour. The pieces this change builds on:

- `ConversationRecorder` (`packages/core/src/conversations/recorder.ts`) is engine-agnostic and already has `resume(id)`. It buffers an exchange and writes it on `interrupted` / `turnComplete`, and `end()` marks the conversation quiet. `ConversationStore.attach/detach/isLive` guard a conversation while a recorder writes into it (DELETE answers 409).
- `TextModel` (`packages/core/src/llm/gemini.ts`) is one non-streaming `generateContent` call, with no tools. `LlmService` (`llm/service.ts`) wraps it with a FIFO `Semaphore`, per-attempt timeout, retry and error classification, and a content-free log line per call. It serves `ctx.llm` only.
- `ToolRegistry` (`packages/sdk/src/registry.ts`) has no notion of channels. `GeminiSession` snapshots `declarations()` at open.
- Core routes get the raw Node `res` (`router.ts`), so an SSE response needs no framework support. Cross-origin writes to `/api/` are already refused (`http-server`).
- The portal has no markdown renderer. `ConversationsPage.vue` already renders stored transcripts (bubbles, collapsible tools).
- The `channel` column (`voice` | `chat`) exists, so no migration is needed.

## Goals / Non-Goals

**Goals:**
- One chat engine that is stateless between messages. All state lives in `friday.db`, so reloads, disconnects and pod restarts between messages lose nothing.
- Reuse the text-model policy (slot, retry, error kinds, logging) instead of building a second one for chat.
- Maximum streaming without making retries produce duplicate text.

**Non-Goals:**
- Tool timeouts that cancel the handler. Handlers have no abort signal today; a timed-out call keeps running and its result is dropped.
- Channel flags for remote module tools. They arrive over MCP without the flag and are available in both channels.
- A generic "Friday speaks first" push path (timers in chat).

## Decisions

### A turn-based engine on the text model, not Live in text mode
Each `POST /api/chat` loads the thread, runs the turn, records it and ends. *Alternative:* a `GeminiSession` with `TEXT` modality per open chat page. Rejected: resuming would mean replaying history into a new Live session, which is bound by session length, and core would hold long-lived per-thread state. Live's model is also tuned for audio. The chat model defaults to `FRIDAY_TEXT_MODEL` so no setting is needed, and `FRIDAY_CHAT_MODEL` allows a stronger model for chat than for background jobs.

### Code layout
`packages/core/src/chat/`:
- `history.ts`: stored entries to Gemini `Content[]`, a pure function (the history replay requirement).
- `engine.ts`: `ChatEngine.turn({ text, conversationId }, emit)`, which runs the loop, calls the registry and drives the recorder. It does not depend on HTTP.
- `route.ts`: body validation, 400/404/409, SSE framing, heartbeat, disconnect handling.

`createApp` mounts the route when a conversation store and the LLM service are present. Without a store, `POST /api/chat` responds 503, because chat without history can't resume.

### Streaming on `TextModel`, policy in `LlmService`
`TextModel` gains `stream(req, { signal })`, which returns an async iterable of chunks: `{ thought }`, `{ text }`, `{ functionCall, thoughtSignature? }`, and a final `{ usage, finishReason, model }`. The request takes raw `contents`, `tools` and `thinkingConfig: { includeThoughts: true }`, so the chat engine owns the `Content[]` it sends. `toGeminiParams` grows a branch for that. Streaming uses `generateContentStream`.

`LlmService` gets `streamCall(owner, req, onChunk)`. It runs one model call under the same semaphore, timeout, classification and log line as `generate`, with the retry loop restricted to failures before the first chunk. After the first chunk has been passed to `onChunk`, errors are rethrown as typed `LlmError`s without retry. The slot is held until the stream ends. The chat engine calls it once per round with owner `chat`. *Alternative:* a separate chat client with its own limits. Rejected, because `FRIDAY_LLM_CONCURRENCY` exists precisely to keep one API key from being rate-limited by several callers at once.

### History replay and thought signatures
`history.ts` maps entries in order: user entry to `{ role: "user", parts: [{ text }] }`, assistant entry to `{ role: "model", parts: [{ text }] }`, and tool entry to a model `functionCall` part followed by a user `functionResponse` part. Consecutive tool entries between two texts are grouped, so parallel calls stay one model turn. Truncated and missing results use the placeholder objects from the spec. Assistant text followed by tool entries of the same exchange is merged into one model turn.

Within the running turn, the engine keeps Gemini's parts **verbatim**, including `thoughtSignature`, and sends them back on the next round. Gemini 3 validates signatures for function calls in the current turn. Replayed calls from earlier turns have no stored signature. **Spike (first task of the engine group):** send a replayed history with unsigned past function calls to the real chat model and confirm it is accepted. If it is rejected, first try Google's documented placeholder signature for injected calls. If that is also rejected, replay past tool entries as short text notes inside the model turn (`[tool ha_get_state {...} -> {...}]`). Only `history.ts` changes; the specs keep their observable behaviour except the replay format, which would then need a spec update before merging.

**Spike result (2026-09-29, `gemini-flash-latest` answering as `gemini-3.8-flash`):** accepted, no fallback needed. `packages/core/test/chat-live.test.ts` (run with `FRIDAY_LIVE_TESTS=1`, and `DOTENV_CONFIG_PATH=<worktree>/.env` so the key is found from the package directory) checks two things. First, a history with an earlier turn's `functionCall` without `thoughtSignature` plus its `functionResponse`, followed by a new question, streams a normal answer (`STOP`). Second, within a turn, the model's first round (a signed `functionCall`) sent back with thought-summary parts left out and every other part unchanged, followed by the function responses, streams the final answer. The engine therefore drops `thought` parts from the model turns it sends back and keeps every other part verbatim.

### Tool loop
One round: stream the model call. Forward `thought` and `text` chunks as `thinking` and `text` events, and collect function calls. With no calls, the turn is done. Otherwise, emit `tool_call` for each, run them concurrently with `registry.callTool(name, args, { channel: "chat" })` raced against `FRIDAY_CHAT_TOOL_TIMEOUT_MS`, emit `tool_result` as each settles, and append the model turn plus all function responses to the in-memory contents. The cap is 10 rounds, a constant: a home assistant never needs more, and a loop beyond that is a model bug that should surface as an error rather than spend tokens.

### Recorder changes
Chat needs two small additions to the recorder, both backwards compatible with voice:
- `commitUser()`: writes the buffered user segment right away, creating the conversation if needed. The engine calls it after `user(text, "text")`, so the id exists for the `start` event and the message is durable before the model runs.
- `release()`: completes and flushes the exchange like `turnComplete()`, writes pending tools, and detaches, **without** `markQuiet`. The conversation stays active and the quiet sweep handles it later.

A failure after text was streamed calls `interrupted()` and then `release()`, so the partial text is stored as interrupted. `start` carries the id from `commitUser()`.

The 409 check for a running turn uses `store.isLive(id)`, with the check and the `resume`/attach done synchronously before the first `await`, so two simultaneous posts can't both pass. A voice session never holds a chat id, so `isLive` on a chat id means a chat turn.

### SSE framing and disconnects
Headers: `content-type: text/event-stream`, `cache-control: no-cache`, `x-accel-buffering: no`. Events are written as `event: <kind>\ndata: <json>\n\n`, and a `: ping` comment every 15 s. The engine receives an `emit` callback. The route's `emit` checks `res.writableEnded` / `res.destroyed` and drops events after a disconnect. The turn itself is never tied to the socket (no abort on `close`). *Alternative:* abort the turn on disconnect. Rejected, because tool side effects may already have happened, and an unrecorded half turn would be confusing on reload.

### Tool channels in the SDK
`Tool.channels?: ("voice" | "chat")[]`, validated in `add`. `declarations(channel?)` filters. `callTool(name, args, opts?: { channel })` treats an out-of-channel tool as unknown. `defineTool` in the module context passes the flag through. `createTestHost` exposes it, so module tests can assert it. `GeminiSession.open` calls `declarations("voice")`. Voice-only is a property of the tool, not a list in core, which keeps the rule "the session never references a tool by name".

### Prompt split
`config.ts` holds `prompts.base` (persona, prefer tools, user's language), `prompts.voice` (short spoken answers and the current end-of-conversation block) and `prompts.chat` (markdown allowed, concise but complete, no mention of ending). `settings.systemPrompt` stays as `base + voice`, so the voice prompt text is unchanged apart from moving the persona line into the base.

### Portal
- `pages/ChatPage.vue`: thread list (`GET /api/conversations?channel=chat`, "Load more") and a thread pane, routes `/chat` and `/chat/:id`, and a `message` icon added to `@friday/portal-ui` (`chat` is used by Conversations).
- `composables/useChatStream.ts`: `fetch` POST, reads `res.body` with a small SSE parser (`EventSource` can't POST), and exposes the reactive live turn (thinking, text, tools, error).
- Transcript rendering is extracted from `ConversationsPage.vue` into a shared `TranscriptEntry` component used by both pages, so stored and streaming entries look the same.
- Markdown: `markdown-it` with `html: false`, `linkify: true`, and a link rule adding `target="_blank" rel="noopener noreferrer"`. While streaming, the accumulated text is re-rendered on each delta, which is cheap at chat sizes and avoids incremental-parser edge cases.
- After `done`, the page reloads the thread from `GET /api/conversations/:id`, so what you see is what was stored.

## Risks / Trade-offs

- [The whole thread is resent every message, so long threads cost more] → Accepted for now (usage is expected to be light). The log line shows input tokens per call, and a budget window can be added later without data changes.
- [Replayed unsigned function calls may be rejected by Gemini 3] → The spike comes first, with two fallbacks designed in; only `history.ts` changes.
- [A timed-out tool keeps running and may still have its effect] → The model is told it timed out, not that it failed. The 30 s default is generous for home tools, and the log records the late settle.
- [Prompt injection through tool results, such as a fetched web page] → Output is rendered without HTML, links carry no opener, and the API refuses cross-origin writes. Tools that act are the same ones voice can already use.
- [A nightly job can hold the slots while you chat] → Accepted. The FIFO bound is small and jobs are short. Priority can be added to `Semaphore` if it ever bites.
- [A proxy buffers SSE] → The `x-accel-buffering` header and heartbeat comments. The k8s path is a plain Service with no buffering ingress, to be checked during manual testing.

## Migration Plan

No database migration: `channel` already allows `chat`. New settings default sensibly (`FRIDAY_CHAT_MODEL` falls back to `FRIDAY_TEXT_MODEL`). Rollback means reverting the image; any `chat` conversations remain readable in `Conversations`.
