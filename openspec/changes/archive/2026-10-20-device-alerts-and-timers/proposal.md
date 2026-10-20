# Proposal

## Why

Friday only speaks when someone wakes it: every device socket is a conversation the device opened. Kitchen timers therefore run as a blocking `set_timer` tool call that keeps a Gemini Live session open for the whole countdown, and anything Friday should start by itself (a timer going off, later a wake-up alarm with a morning briefing) has no way to reach a device. This change lets Friday reach a device on its own, and uses that for timers. Recurring alarms and the morning briefing come in a follow-up change.

## What Changes

- **Device control connection.** An accepted voice device keeps a long-lived, authenticated control connection to core while it's idle. It carries no audio and no Gemini session, only small JSON messages. Core uses it to tell the device to ring. Device status reports a device as online while this connection is open.
- **Server-started sessions (alerts).** When an alert is due, core sends `ring` to its device. The device opens its usual `/ws/audio` session itself, naming the alert, so authentication, device context and recording work as they do for the wake word. Core starts that session with a short tone it sends as audio, followed by a first turn built from the alert ("your eggs timer is done"). The user can then answer by voice: stop, thanks, snooze, or a follow-up question.
- **Ringing until acknowledged.** In an alert session, silence doesn't end the alert. Core rings again a limited number of times. After that the alert is recorded as missed and shown in the portal. An alert is done only when the user dismisses it, snoozes it, or replies.
- **Fallback tone.** When the alert session can't open (for example, Gemini is unavailable or the connection times out), or the microphone is muted, the device plays a local tone until its button is pressed or a time limit passes. An alarm still rings when Gemini is down.
- **Alerts survive restarts.** Alerts are stored in `friday.db`. One that falls due while Friday is down still rings if it's only a little late. One that is too far past its time is recorded as missed instead.
- **Timer tools.** New voice tools set, list, cancel and snooze timers. A timer returns immediately and rings on the device it was set from. **BREAKING:** they replace the blocking `set_timer`. Timers need a device: setting one from a session without a device (the Talk page) or from chat returns an error.
- **Device in the tool call context.** Tool handlers learn which voice device a call came from, so a timer knows where to ring.
- **Firmware** (Voice PE and reSpeaker, shared `friday_client`): control connection with reconnects, `ring` handling, alert sessions, the fallback tone (built on the existing chime generator), and ringing even when the microphone is muted.

### Non-goals

- Recurring alarms, snooze schedules for alarms, and the morning briefing (weather, agenda, travel time). These are the follow-up change, which also needs to pick a weather source.
- Push notifications to a phone. This is the planned target for alerts set without a device. Alerts get a target kind (only `device` for now), so push can be added as another kind later.
- Alerts that ring when Friday itself is down. That would mean storing alerts on the device.
- Ringing on several devices, or on a device other than the one the timer was set from.

## Capabilities

### New Capabilities
- `alerts`: Alerts stored in `friday.db` with a due time, label and target. Covers firing, server-started alert sessions, ringing again on silence, dismiss and snooze, missed alerts, lateness after a restart, the timer tools, and the portal view of upcoming and missed alerts.

### Modified Capabilities
- `audio-transport`: A control connection per device (authenticated like `/ws/audio`, with keepalive and the `ring` message), and the `alert` parameter on `/ws/audio` that turns a session into an alert session.
- `voice-session`: Alert sessions start with core-sent tone audio and a first turn from the alert. In an alert session, silence means ringing again rather than closing for inactivity.
- `voice-devices`: A device is reported online while its control connection is open, not only during a conversation. Revoking, deleting or replacing a key also closes the control connection.
- `builtin-tools`: `set_timer` is removed. Its role moves to the alert-backed timer tools.
- `tool-registry`: The call context carries the voice device id for calls from a device session.
- `voice-pe-client`: Control connection, `ring` handling, alert sessions, fallback tone, ringing while muted.
- `respeaker-client`: The same alert behaviour as the Voice PE, and the LED ring shows the ringing state.
- `portal-shell`: The Settings section gains an `Alerts` page.

## Impact

- **Core:** `packages/core/src/transports/ws.ts` (control connection, `alert` parameter), `packages/core/src/session.ts` (alert sessions, opening audio, ringing again instead of the idle close), `packages/core/src/devices/` (online status, closing the control connection), a new alerts service with a `friday.db` migration in `packages/core/src/storage/db.ts`, `packages/core/src/app.ts` wiring.
- **SDK:** the `ToolCallContext` device id in `packages/sdk/src/tool.ts`. Probably also a way for the timer tools' module to create and manage alerts, decided in the design.
- **Modules:** `modules/builtin` (`set_timer` removed, or the timer tools added there, depending on the design).
- **Portal:** online status on the Voice devices page; a view of upcoming and missed alerts.
- **Firmware:** `esphome/components/friday_client/*`, `esphome/friday-voice-pe.yaml`, `esphome/friday-respeaker.yaml`. Both devices need to be reflashed over OTA. Older firmware keeps working for conversations but never rings.
- **Docs:** README, `.env.example` (any new alert settings), `openspec/config.yaml` context.
