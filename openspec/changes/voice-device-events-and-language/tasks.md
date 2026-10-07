# Tasks

## 1. Device connections get only control events

- [ ] 1.1 In `packages/core/test/ws.test.ts`, next to "session events are relayed and closed event closes the socket", add a test for an authenticated device connection (`deviceFixture`, `h.connect("?device=kitchen", key)`). Have the stub session emit `audio`, `user_text`, `bot_text`, `tool_call`, `tool_result` (with a large payload), `interrupted`, `turn_complete` and `closed`. Assert the device receives only the audio frame, `interrupted`, `turn_complete` and `closed`, in that order, and that the socket closes. Extend the existing browser test (or add one) so a connection without `?device=` still receives all kinds. Write the tests first and watch the device test fail.
- [ ] 1.2 In `packages/core/src/transports/ws.ts`, filter the session's events for connections with an authenticated `device`: send audio and `interrupted`, `turn_complete`, `closed`; skip `user_text`, `bot_text`, `tool_call` and `tool_result`. Recording is untouched (the recorder gets events from the session, not from the socket). Verify: `pnpm --filter @friday/core test` and `pnpm --filter @friday/core typecheck` pass, and the recording tests (`the device query parameter is recorded …`) still pass.

## 2. Dutch or English

- [ ] 2.1 Change `prompts.base` in `packages/core/src/config.ts`: the user speaks Dutch or English; answer in the language they speak; speech that seems to be in any other language was almost certainly misheard Dutch, so treat it as Dutch and answer in Dutch. Keep the rest of the base unchanged. Add or adjust a prompt test (e.g. in `packages/core/test/session.test.ts` or `chat-config.test.ts`, wherever the base text is asserted) that checks the voice and chat prompts both contain the Dutch/English rule. Verify: core tests and typecheck pass.

## 3. Docs and check on the devices

- [ ] 3.1 README: in the Voice devices or Transport section, note that device connections receive only audio and the control events, and mention the Dutch/English rule where the prompt is described (if it is). Verify the `openspec/config.yaml` context still reads correctly (the protocol line there mentions the event kinds).
- [ ] 3.2 After deploy (merge to `main`), on the reSpeaker at home: ask something that makes Friday list all Home Assistant entities ("which lights are in the house?"). The reply plays normally, the device doesn't reboot, and its log shows no `ignoring a N-byte text message` (the server no longer sends it). Ask a question in Dutch and one in English and check the answers come back in the same language.
