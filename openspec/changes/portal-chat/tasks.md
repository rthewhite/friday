# Tasks

## 1. Tool channels

- [x] 1.1 Add `channels` to `Tool` in `packages/sdk/src/tool.ts`, validate it in `ToolRegistry.add` (`invalid channels for <name>`), filter `declarations(channel?)`, and treat out-of-channel tools as unknown in `callTool(name, args, { channel })`; verify with new registry tests in `packages/sdk/test/` covering default channels, narrowing, invalid values and the restricted call not running the handler
- [x] 1.2 Pass `channels` through `ctx.defineTool` and `createTestHost`; verify a module test can read a tool's channels
- [x] 1.3 Mark `set_timer` and `end_conversation` as `channels: ["voice"]` in `modules/builtin`; verify with builtin tests that neither is in `declarations("chat")` and both are in `declarations("voice")`
- [x] 1.4 Make `GeminiSession.open` use `declarations("voice")`; verify with a session test that a chat-only tool is not declared
- [x] 1.5 Verify that MCP and remote module tools register without `channels` and appear in both channels (existing MCP/remote tests extended); run `pnpm --filter @friday/sdk test typecheck`, `pnpm --filter @friday/core test typecheck` and the builtin module's tests

## 2. Prompt split and chat settings

- [x] 2.1 Split the system prompt in `packages/core/src/config.ts` into `base`, `voice` and `chat` parts, with `systemPrompt` = base + voice; verify with a config test that both prompts start with the base and only voice mentions `end_conversation`
- [x] 2.2 Add `FRIDAY_CHAT_MODEL` (falling back to the text model) and `FRIDAY_CHAT_TOOL_TIMEOUT_MS` (default 30000) to the settings; verify with a settings test for the fallback and default, and document both in `.env.example`

## 3. Conversation store for chat

- [x] 3.1 Add a `channel` filter to `ConversationStore.list` and to `GET /api/conversations` (400 for an unknown value, filter kept across `before` paging); verify with store and API tests
- [x] 3.2 Add `commitUser()` and `release()` to `ConversationRecorder` as in design.md; verify with recorder tests that the user entry is written immediately, a released conversation stays active and detached, `interrupted()` + `release()` stores partial text as interrupted, and the voice recorder tests still pass
- [x] 3.3 Run `pnpm --filter @friday/core test typecheck`

## 4. Streaming text model and shared policy

- [x] 4.1 Add `stream()` to `TextModel` / `GeminiTextModel` (`generateContentStream` with raw contents, tools and `includeThoughts`), yielding thought, text, function-call (with `thoughtSignature`) and final usage chunks; verify with tests against a stubbed stream
- [x] 4.2 Add `LlmService.streamCall(owner, req, onChunk)` using the shared semaphore, per-call timeout, error classification and log line, retrying only before the first chunk; verify with tests for a 429 before output (retried, logged), a failure after output (not retried, typed error), a slot held while streaming and shared with `generate`, and a log line without content under owner `chat`
- [x] 4.3 Run `pnpm --filter @friday/core test typecheck`

## 5. Chat engine

- [x] 5.1 Spike: with a real `GEMINI_API_KEY`, send the chat model a history with unsigned past function calls/responses and a new message, and record the outcome (and the fallback chosen, if any) in design.md; verify the spike script's result is noted in design.md, and update the `portal-chat` spec first if the replay format changes
- [x] 5.2 Implement `chat/history.ts` (entries to `Content[]`, grouped tool calls, truncated and missing-result placeholders); verify with pure tests for each entry kind, grouping and placeholders
- [x] 5.3 Implement `chat/engine.ts`: resume or create the chat conversation, `commitUser`, the round loop with verbatim parts within the turn, concurrent tool calls restricted to `chat` with the timeout, ignored scheduling/`endConversation`, the 10-round cap, events, and recording with `release()`; verify with engine tests using a fake streaming model and registry: two tools then an answer, timeout, voice-only call, round cap, failure after text (interrupted entry), key missing (`unavailable`, user entry stored), and tools read fresh per turn
- [x] 5.4 Run `pnpm --filter @friday/core test typecheck`

## 6. Chat API

- [x] 6.1 Implement `chat/route.ts` and mount `POST /api/chat` in `createApp`: 400 for empty text, 404 for unknown or voice ids, 409 while a turn runs (synchronous check), 503 without a conversation store, SSE headers and framing, a `start` first event, 15 s heartbeat comments, and events dropped after disconnect while the turn continues; verify with HTTP tests covering each status, event order for a tool-using turn, the heartbeat (with a short interval), and a client abort mid-turn that still records the answer
- [x] 6.2 Verify `DELETE /api/conversations/:id` answers 409 during a chat turn, and that a cross-origin `POST /api/chat` is refused with 403, with API tests
- [x] 6.3 Run `pnpm --filter @friday/core test typecheck`

## 7. Portal Chat page

- [x] 7.1 Add `markdown-it` to the portal and a render helper with `html: false`, linkify and `target="_blank" rel="noopener noreferrer"`; verify with a unit test (or a typechecked helper test) that `<img src=x onerror=alert(1)>` renders as text and links get the attributes
- [x] 7.2 Extract `TranscriptEntry` from `ConversationsPage.vue` and use it there; verify the Conversations drawer renders as before in `pnpm dev`
- [x] 7.3 Add `useChatStream` (fetch POST, SSE parser, reactive live turn); verify the parser with tests for split chunks, multiple events per chunk and comment lines
- [x] 7.4 Build `ChatPage.vue` with routes `/chat` and `/chat/:id`, the thread list with `New chat` and "Load more", streaming thinking/text/tools, the input (Enter / Shift+Enter, disabled while running), URL update after the first message, inline errors, the not-found notice, reload from the API after `done`, and the collapsed thread list at 360 px; add the `message` icon to `@friday/portal-ui` and the `Chat` nav item between `Talk` and `Conversations`, highlighted on `/chat/*`; verify with `pnpm --filter @friday/portal typecheck build` and by hand in `pnpm dev` (on free ports) against a real key: new thread, resume, tool call, reload mid-turn, 360 px
- [x] 7.5 Add `Open in Chat` to the Conversations drawer for chat conversations only; verify by hand that it opens `/chat/<id>` and is absent for voice conversations

## 8. Docs and integration

- [x] 8.1 Update the README (Chat page, what is stored for chat, `FRIDAY_CHAT_MODEL`, `FRIDAY_CHAT_TOOL_TIMEOUT_MS`, tool `channels`), the SDK README (`channels` on `defineTool`), and the `openspec/config.yaml` context (chat engine, `/api/chat`, channels); check `deploy/k8s.yaml` needs no change and verify the documented settings match `config.ts`
- [x] 8.2 Run `pnpm -r build && pnpm -r typecheck && pnpm -r test` and verify it is green
