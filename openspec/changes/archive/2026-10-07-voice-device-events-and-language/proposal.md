# Proposal

## Why

Two problems surfaced while testing the reSpeaker satellite on 2026-10-06:

- **Large events crashed a device.** The server forwards every session event to every audio WebSocket, including `tool_result` with the tool's full output. A Home Assistant `list_entities` result of tens of KB made the reSpeaker run out of internal RAM while buffering it and abort. The devices never act on these events (`voice-pe-client`, "Ignored protocol events"). `friday_client` now skips text messages over 4 KB as a defence, but the server should not send them at all.
- **Dutch was taken for Spanish.** Gemini transcribed a Dutch question as Spanish and answered in Spanish, then derailed. The prompt only says "answer in the language the user speaks", with no hint which languages to expect.

## What Changes

- Audio WebSocket connections that authenticated as a voice device (`?device=`) receive only audio and the control events `interrupted`, `turn_complete` and `closed`. They no longer receive `user_text`, `bot_text`, `tool_call` or `tool_result`.
- Connections without `?device=` (the browser Talk page) keep receiving every event kind, unchanged.
- The base prompt tells the model the user speaks Dutch or English and to answer in the language they speak. Speech that looks like any other language is almost certainly misheard Dutch, so the model treats it as Dutch. The language is not pinned: English stays English.
- What the session records in the conversation store is unchanged; only what goes over the device's socket changes.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `audio-transport`: server-to-client text frames depend on the connection: voice-device connections get only `interrupted`, `turn_complete` and `closed`.
- `voice-session`: the base prompt's language rule names Dutch and English and says to treat other-sounding speech as Dutch.

## Impact

- `packages/core/src/transports/ws.ts`: filter session events for device connections (around lines 119-123).
- `packages/core/src/config.ts`: the `prompts.base` text.
- Tests: `packages/core/test/ws.test.ts` (device vs browser connections), and the prompt test in `packages/core/test/core-config.test.ts` if it pins the base text.
- No change for the devices: both run `friday_client`, which already ignores these events. No change for the portal.
- No configuration, migration or dependency changes.
