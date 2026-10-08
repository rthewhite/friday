# Tasks

## 1. Alert storage

- [x] 1.1 Add core migration 8 `alerts` in `packages/core/src/storage/db.ts` (columns and indexes as in design decision 2) and verify `pnpm --filter @friday/core test` passes `storage.test.ts`, including a new case that the migration creates the table on a version-7 database
- [x] 1.2 Implement `AlertStore` in `packages/core/src/alerts/store.ts`: create (short base32 id unique among non-final alerts), get, list (non-final first, then final newest first), due rows by `next_ring_at`, state transitions with `finished_at`, rings/local updates, cancel-by-device, and pruning to the 200 newest final alerts. Verify with `packages/core/test/alert-store.test.ts` covering each, including that ids aren't reused among scheduled alerts and that pruning keeps non-final rows

## 2. Device control connection

- [x] 2.1 Move device authentication out of `serveWs` into `transports/device-auth.ts` (`authenticateDevice(ws, req, devices)`) and verify the existing `ws.test.ts` device cases (4400, 4401, 4403, pending attempt, key in URL, store error → 1011) still pass unchanged
- [x] 2.2 Add `DeviceLinks` in `packages/core/src/devices/links.ts` (one socket per device, `4409 replaced`, `send`, `online`, `onOnline`, `disconnect` with 4401), and `DeviceSessions.onIdle` when a device's last audio socket closes. Verify with unit tests in `packages/core/test/device-links.test.ts`
- [x] 2.3 Mount `/ws/device` in `transports/device-ws.ts` with `keepAlive`, shared authentication, ignoring binary and malformed frames, and routing `ringing_locally` / `acknowledged` / `unanswered` to an injected report handler. Verify with `packages/core/test/device-ws.test.ts`: accepted device stays open without a Gemini session, unregistered device → 4403 plus pending attempt, second connection replaces the first with 4409, malformed frames ignored, reports reach the handler, dead connection terminated after missed pongs
- [x] 2.4 Close control connections on revoke, delete and key replacement, and report `online` alongside `connected` in `GET /api/devices`. Verify with new cases in `devices-api.test.ts` (online flag, revoke closes the control socket with 4401)

## 3. Session options and the device in the call context

- [x] 3.1 Add `device?: string` to `ToolCallContext` in `packages/sdk/src/tool.ts` and pass it through `ToolRegistry.callTool` options. Verify with new cases in `packages/sdk/test/registry.test.ts` (device reaches the handler, absent without options) and `pnpm --filter @friday/sdk typecheck`
- [x] 3.2 Add `SessionOptions.device` to `GeminiSession` and pass it in `runTool`; have `serveWs` set it from the authenticated device. Verify with `session.test.ts` (a device session's tool call sees the device, a Talk page session's doesn't)
- [x] 3.3 Add `SessionOptions.opening` (tone `audio` events in 100 ms chunks before Gemini audio, then the opening text through `sendClientContent`, not recorded) and verify with `session.test.ts`: event order, the recorder holds no user entry for the opening, and the opening doesn't release `holdInterrupted` or count as user input
- [x] 3.4 Add `SessionOptions.awaitUser` (drop end requests until the first input, idle reason `ended: no answer`, 8000 ms even when `FRIDAY_IDLE_TIMEOUT_MS` is 0, `onFirstInput` called once on the first transcription or `sendText`). Verify with `session.test.ts` covering the voice-session spec scenarios "Model tries to end right away", "User answers", "Nobody answers an alert" and "Timeout disabled"
- [x] 3.5 Update the README's idle timeout paragraph (no more "paused while a timer runs"; alert sessions close with `no answer`) and verify it matches the voice-session spec

## 4. Alert service

- [x] 4.1 Implement `alerts/tone.ts` (about 2 s of rising two-note chimes, 24 kHz s16le, about −12 dBFS, faded ends) and verify with a unit test of length, peak level and zero first/last samples
- [x] 4.2 Implement the opening text builder (kind, label, length, set and due time in `FRIDAY_TIMEZONE`, "N minutes ago" past one minute, language named, snooze hint, several alerts in one text) and verify with unit tests for one alert, a late alert, several alerts and both languages
- [x] 4.3 Implement `AlertService` firing: the single re-planned timer capped at one hour, grouping due alerts per device, sending one `ring` through `DeviceLinks` only when the device is online and has no open audio socket, setting `ringing`, and the 15 s answer timer. Verify with `packages/core/test/alert-service.test.ts` on the fake clock: timer goes off, two timers at once give one ring, device busy rings on `onIdle`, offline device rings on `onOnline`
- [x] 4.4 Implement claims and outcomes: `claim(deviceId, alertId)` (all ringing alerts of the device, or `undefined`), `acknowledge`, `closed`, unanswered counting with `next_ring_at = now + FRIDAY_ALERT_RING_INTERVAL_MS`, `missed` after `FRIDAY_ALERT_RINGS`, and sending `stop` when an alert leaves `ringing`. Verify with `alert-service.test.ts` covering "Answered at once", "Nobody in the kitchen", "Answered on the third ring" and the missing-claim timeout
- [x] 4.5 Implement device reports (`ringing_locally` stops server rings, `acknowledged` and `unanswered` set the final state, reports for alerts not ringing on that device ignored) and verify with `alert-service.test.ts`
- [x] 4.6 Implement grace and startup: no ring starts past `FRIDAY_ALERT_GRACE_MS`, rings in progress aren't cut off, and at startup `local` is reset and `ringing` rows are due now. Verify with `alert-service.test.ts` covering "Short restart", "Long outage", "Device offline past the limit" and a local ring that outlasts grace
- [x] 4.7 Implement `create`, `list`, `cancel` (sends `stop` when ringing), `snooze(deviceId, minutes)` (the device's open claim, reset rings, back to `scheduled`), and `cancelDevice(deviceId)`. Verify with `alert-service.test.ts`, including snooze outside an alert session failing
- [x] 4.8 Read `FRIDAY_ALERT_RINGS`, `FRIDAY_ALERT_RING_INTERVAL_MS` and `FRIDAY_ALERT_GRACE_MS` in `packages/core/src/config.ts` settings, document them in `.env.example`, and verify the defaults (5, 60000, 600000) with a settings test

## 5. Alert sessions on /ws/audio

- [x] 5.1 Read `alert` in `serveWs` for device connections: no claim → close `4410 alert gone` before any Gemini session; a claim → session with `opening` (tone and text) and `awaitUser` wired to the claim, `claim.closed` on `closed` and on a Gemini open failure. Verify with `ws.test.ts` covering "Answering a ring", "Alert cancelled meanwhile", "Gemini unavailable" and "Talk page" (alert ignored without a device)
- [x] 5.2 Verify end to end with fakes in `packages/core/test/alerts-e2e.test.ts`: a timer created through the service rings a fake control socket, a fake device opens `/ws/audio?alert=`, receives tone audio before the fake Gemini audio, the user's transcription acknowledges, and the alert ends `acknowledged`; without an answer it rings again after the interval

## 6. Timer tools

- [x] 6.1 Implement `registerAlertTools(registry, alerts)` in `alerts/tools.ts` with `set_timer` (seconds 1–86400, label up to 60, `language` `nl`/`en`, errors for no device, device offline, 20 timers), `list_timers`, `cancel_timer` (id, label, the only one, ambiguous error listing timers) and `snooze_alert` (1–60, default 5), all voice-only and owned by `core`. Verify with `packages/core/test/alert-tools.test.ts` covering every scenario in the alerts spec's tool requirements
- [x] 6.2 Remove the blocking `set_timer` from `modules/builtin` (manifest description and tools), update `modules/builtin/test/builtin.test.ts` to expect `get_current_time` and `end_conversation` only, and verify `pnpm --filter @friday/module-builtin test`
- [x] 6.3 Update `openspec/config.yaml` context: the voice-only tools are now the alert tools and `end_conversation`, the call context carries `device`, and a short alerts paragraph covers `/ws/device`, `DeviceLinks`, `AlertService`, migration 8 and the `alert` parameter. Verify `openspec validate device-alerts-and-timers --strict` still passes

## 7. Alerts API and portal

- [ ] 7.1 Add `GET /api/alerts` and `DELETE /api/alerts/:id` (204, 404, 409) to the app, and make device deletion cancel the device's alerts. Verify with `packages/core/test/alerts-api.test.ts` covering listing order, target labels for deleted devices, and each response code, plus a `devices-api.test.ts` case for deletion
- [ ] 7.2 Add the `Alerts` page at `/settings/alerts` (active alerts with time left and `Cancel`, finished alerts with outcome and `missed` highlighted, `Refresh`) and the `System` nav entry. Put list formatting in a pure lib function and test it in `packages/portal/test/alerts.test.ts`; verify `pnpm --filter @friday/portal test` and `pnpm --filter @friday/portal typecheck`
- [ ] 7.3 Show online, in a session, offline and revoked status dots on the Voice devices page, with the help text about offline devices not ringing. Extend `packages/portal/test/devices.test.ts` for the status mapping and verify portal test and typecheck
- [ ] 7.4 Document alerts and timers in the README (what rings where, the ring cycle, missed alerts, the Alerts page, firmware needed) and verify every documented setting exists in `.env.example`

## 8. Core wiring

- [ ] 8.1 Wire `AlertStore`, `AlertService`, `DeviceLinks`, `attachDeviceWs` and `registerAlertTools` in `packages/core/src/server.ts`, start the service after modules load, and stop it on shutdown. Verify with `pnpm -r build && pnpm -r typecheck && pnpm -r test`, and by running `pnpm dev` with a free port: the startup log lists the four alert tools, and `/api/alerts` and `/ws/device` answer (a `wscat` connection without a key is closed with 4401)
- [ ] 8.2 Check `deploy/k8s.yaml` for ingress or proxy rules that only pass `/ws/audio`, add `/ws/device` where needed, and verify by reading the manifest

## 9. Firmware

- [ ] 9.1 Add the control client to `friday_client`: URL derived from `url` (`/ws/audio` → `/ws/device`) with an optional `control_url`, auto-reconnect off, backoff 1 s doubling to 60 s, 60 s after 4401/4403/4409, frames queued to `loop()`, `is_online()`, and free internal heap logged at connect. Verify by compiling both `esphome/friday-voice-pe.yaml` and `esphome/friday-respeaker.yaml`, and on the Voice PE: it shows as online in the portal and reconnects after a core restart
- [ ] 9.2 Add `State::RINGING`, `start_alert_(id)` (`&alert=`, no chime), the `4410` → idle and other-failure → local ring rules, and `acknowledged` when the button ends an alert session. Verify by compiling both configs and, on the Voice PE, a 30-second timer that rings with tone and announcement
- [ ] 9.3 Add the local ring (chime loop through the player, `ringing_locally`, stop on button, `stop` or `ring_limit` default 5 min, with `acknowledged`/`unanswered`) and ringing on `ring` while muted. Verify on the Voice PE with the hardware mute on (local tone, button stops it, the portal shows `acknowledged`) and with an invalid Gemini key (local tone after `1011`)
- [ ] 9.4 Wire the YAMLs: the `ringing` LED pattern for both, an online binary sensor, and the reSpeaker `on_mute` handler that stops ringing and restores the previous mute state. Verify on the reSpeaker: a timer while muted rings locally, the Mute button stops it, and the device stays muted
- [ ] 9.5 Document the control connection, ringing behaviour, `control_url` and `ring_limit` in the firmware sections of the README, and verify the documented options match `friday_client/__init__.py`

## 10. Integration checks

- [ ] 10.1 On both devices after OTA: set a 1-minute timer by voice, let it ring once unanswered, answer the second ring with "snooze two minutes", then answer with "thanks". Verify that the Alerts page shows the timer `acknowledged` and that the conversation starts with Friday's announcement
- [ ] 10.2 Restart core while a timer is due within a minute, and verify it rings after startup and says how late it is. Then set a timer, unplug the device past the grace limit, and verify the Alerts page shows it `missed`
- [ ] 10.3 Check free internal heap logged by both devices with the control connection and a session open, and verify it stays above the level seen before this change minus the control client's buffers, with no resets over a day of idle
