## Context

`GeminiSession` (`packages/core/src/session.ts`) sets `endRequested` when a tool result carries `endConversation`. It closes on the next `serverContent.turnComplete`, and otherwise arms the idle timer. The session already receives Friday's words as `outputTranscription` chunks, which it forwards as `bot_text` and records, but it doesn't keep them. In the failing conversation (proposal.md, Why), the tool call arrived about 1.2 s after the question's transcript started, and the turn completed about 3.8 s later.

## Goals / Non-Goals

**Goals:**
- A deterministic guard in the session that doesn't depend on the model following the prompt.
- Keep today's behaviour for every other end request.

**Non-Goals:**
- Classifying intent beyond a trailing question mark. Rhetorical or unpunctuated questions are out of scope.
- Telling the model that its end request was dropped. The tool response has already gone out as `{ ending: true }`.
- Any change to the chat channel, where end requests are already ignored.

## Decisions

**Decide at `turnComplete`, not when the tool result arrives.** Gemini can call `end_conversation` before it has spoken (or before the transcription has caught up with) its final words. Only at `turnComplete` is the turn's transcript complete. The alternative was to refuse inside the tool handler by returning an error to the model. The handler doesn't see the transcript, and the transcript may still be incomplete at that point, so this was rejected.

**Keep the turn's transcript in a per-turn buffer.** Append each `outputTranscription.text` to a string, and clear it after every `turnComplete` is handled. The check trims the tail, strips trailing closing quotes and brackets (`"'”’»)]}` and similar), and tests the last character against `? ？ ؟`. This lives in a small exported helper (`endsWithQuestion`) so it can be unit-tested without driving a session. Only the trailing character counts, so "Want the lights on? Done." still ends the conversation.

**Drop the request instead of keeping it pending.** When the check matches, clear `endRequested` and arm the idle timer. If `endRequested` stayed set, the user's answer would be followed by a close at the next `turnComplete`, which would cut off the conversation the guard just saved. The alternative, "close at the next turn unless the user speaks", is exactly what the idle timer already does.

**Pass a distinct idle reason to the timer.** `armIdle` takes the close reason as a parameter, `ended: no follow-up` by default. The turn that drops a request arms it with `ended: no follow-up (end after question)`. Every later `turnComplete` re-arms with the default, and speech clears the timer, so no state needs to be kept. A flag was considered and rejected: it would have to be cleared on the same events, for the same result. The reason is recorded as the conversation's end reason, so these cases show in the Conversations page without adding a new field.

**The prompt and tool description are the first layer, and the session check is the backstop.** Better wording reduces how often the case happens. The check covers the times the model still gets it wrong.

## Risks / Trade-offs

- [Output transcription sometimes has no punctuation] → The guard then does nothing and behaviour is as today. The prompt change still helps.
- [A closing statement that happens to end with "?" (e.g. "Anything else?") now keeps listening for up to 8 s] → This is intended. Asking "anything else?" is an invitation to answer, and the idle timer ends it.
- [After a dropped end, the model believes the conversation ended] → If the user answers, Gemini just replies to the new input. The tool response doesn't stop it from continuing.
- [`FRIDAY_IDLE_TIMEOUT_MS=0` means a dropped end never closes] → This is consistent with "never close for inactivity". The client can still close.

## Migration Plan

No data or configuration migration. It ships with the next deploy. To roll back, revert the merge.
