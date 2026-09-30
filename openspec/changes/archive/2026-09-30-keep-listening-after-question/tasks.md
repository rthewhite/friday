## 1. Session keeps listening after a question

- [x] 1.1 Add an exported `endsWithQuestion(text)` helper in `packages/core/src/session.ts` (trim, strip trailing closing quotes/brackets, last char in `? ？ ؟`). Verify with unit tests in `packages/core/test/session.test.ts` for `?`, `？`, `؟`, `?"`, `?)` plus trailing space, a mid-turn question ("Want the lights on? Done."), and empty text.
- [x] 1.2 Buffer the turn's `outputTranscription` text in `GeminiSession`, cleared after each `turnComplete`. At `turnComplete`, if an end was requested and the buffer ends with a question, drop `endRequested`, log `gemini: end requested after a question, keeping the session open`, and arm the idle timer. Otherwise keep today's behaviour. Verify with a session test that replays the c1e1a36e sequence (transcript "What would you like to share with me today?", `end_conversation` result, `turnComplete`) and asserts no `closed` event.
- [x] 1.3 Give `armIdle` a reason parameter: the turn that drops an end arms it with `ended: no follow-up (end after question)`, and every other turn with `ended: no follow-up`. Verify with session tests (short `FRIDAY_IDLE_TIMEOUT_MS`): silence after a dropped end gives that reason; after a dropped end, user speech then a normal turn doesn't close, and a later silence gives `ended: no follow-up`; "Done." or a mid-turn question with an end request still closes with `ended: <reason>`; with the timeout at 0 a dropped end stays open; the existing endConversation and interrupted-suppression tests still pass.
- [x] 1.4 Run `pnpm --filter @friday/core test` and `pnpm --filter @friday/core typecheck` in the foreground and verify both pass.

## 2. Prompt and tool wording

- [x] 2.1 Extend the voice part in `packages/core/src/config.ts`: never call `end_conversation` in a turn whose reply ends with a question or invites the user to talk, and an invitation to chat, tell something or share information is an open conversation, not a finished request. Verify with an assertion in `packages/core/test/chat-config.test.ts` that the voice prompt contains the question rule and that chat and base still don't mention `end_conversation`.
- [x] 2.2 Update the `end_conversation` description in `modules/builtin/src/index.ts` to say never to call it when the final words are a question or invite the user to talk. Verify with an assertion in `modules/builtin/test/builtin.test.ts` on the voice declaration's description, then run `pnpm --filter @friday/module-builtin test` and `typecheck`.
- [x] 2.3 Update README's voice-session bullets (ending after a question keeps listening until the idle timeout) and the end-reason list in the conversations section (add `ended: no follow-up (end after question)`). Verify by reading the rendered sections against the voice-session spec delta.

## 3. Integration

- [x] 3.1 Run `pnpm -r build && pnpm -r typecheck && pnpm -r test` in the worktree and verify all are green.
