## Why

Friday sometimes asks a question and ends the conversation in the same turn, so the microphone closes before the user can answer. In conversation `c1e1a36e` (2026-09-30 06:11) the user asked to talk about their life. Friday answered "What would you like to share with me today?" and called `end_conversation` with reason `request done`, and the session closed about four seconds later. Today the only guard against this is a line in the prompt, and the model sometimes ignores it.

## What Changes

- When an end of conversation is requested in a turn whose spoken words end with a question mark (`?`, `？` or `؟`), the voice session no longer closes when that turn completes. It drops the end request and arms the normal idle timer instead, so the user can answer.
- If the user stays silent until the idle timeout, the session closes with a distinct reason, `ended: no follow-up (end after question)`, so these cases stand out in the conversation list. If the user speaks, the conversation carries on as usual.
- An end requested after a turn that does not end in a question behaves as before: the session closes right after the turn.
- The voice prompt gets a firm rule: never call `end_conversation` in a turn whose reply ends with a question or invites the user to talk. An invitation to chat, tell something or share information is an open conversation, not a finished request.
- The `end_conversation` tool description says the same: do not call it when the final words are a question.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `voice-session`: an end request is ignored when the turn's spoken words end with a question (falling back to the idle timer with a distinct close reason). The voice prompt forbids ending after a question or an invitation to talk.
- `builtin-tools`: the `end_conversation` description tells the model not to call it when its final words are a question.

## Impact

- `packages/core/src/session.ts`: collect the turn's output transcription and check it at `turnComplete` before honouring `endRequested`. Clear the request when declining, and give the idle close its reason.
- `packages/core/src/config.ts`: voice prompt wording.
- `modules/builtin/src/index.ts`: `end_conversation` description.
- Tests: `packages/core/test/session.test.ts`, `packages/core/test/chat-config.test.ts`, `modules/builtin/test/builtin.test.ts`.
- Docs: README's voice-session section (ending behaviour and the list of end reasons).
- No API, storage, migration or configuration changes. There are no other in-flight changes.
