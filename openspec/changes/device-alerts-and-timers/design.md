# Design

## Context

See `proposal.md` for the motivation and `specs/` for the behaviour. The parts of the current code this design builds on:

- **`/ws/audio` (`packages/core/src/transports/ws.ts`).** `serveWs` authenticates `?device=` with `DeviceStore.authenticate` and the bearer key. It registers the socket in `DeviceSessions`, which tracks open audio sockets per device for "connected" and for closing them on revoke. It then opens one `GeminiSession` per socket and filters events with `DEVICE_EVENTS`.
- **`GeminiSession` (`packages/core/src/session.ts`).** It owns the end-request rules (drop after a question, withhold `interrupted`), the idle timer, and recording. It never names a tool. `runTool` passes `{ channel, conversationId }` to `registry.callTool`.
- **Composition (`packages/core/src/server.ts`).** It wires the stores, the `Scheduler`, `ModuleHost` and `attachAudioWs`. Core already registers its own job (`registerRetention`), so core-owned behaviour that isn't a module has a precedent.
- **Timers today.** `set_timer` is in `modules/builtin`, voice-only, and blocks inside its handler.
- **Firmware (`friday_client`).** It has one `esp_websocket_client` per session, created in `start()` and destroyed in `loop()`. A player task drains a PSRAM ring buffer, and `chime()` synthesises a two-tone chime into that buffer. The state is an atomic `State` (`IDLE`, `CONNECTING`, `LISTENING`, `SPEAKING`, `ERROR`, `PENDING`). Both device configs set `CONFIG_MBEDTLS_EXTERNAL_MEM_ALLOC`, so TLS buffers live in PSRAM. The configured `url` is the full `/ws/audio` URL.
- **reSpeaker mute.** The XVF3800 toggles mute natively when its Mute button is pressed. The `xvf3800` hub only polls GPO 30 and reports changes through `on_mute`. The ESP never sees the button press itself.
- **Migrations.** Core's migrations are at version 7 (`voice-devices`).

## Goals / Non-Goals

**Goals:**
- One place in core decides when an alert rings, counts rings, and marks alerts missed. Transports and the session only report what happened.
- `GeminiSession` stays alert-agnostic. It gets generic options (opening audio and turn, "wait for the user"), not knowledge of alerts.
- The alert session is an ordinary device session with extra options, so authentication, the device block, event filtering and recording need no second code path.
- The firmware changes stay inside `friday_client` plus YAML wiring. No new ESPHome component.

**Non-Goals:**
- No generic scheduler for one-shot jobs. Alerts have their own loop, because the `Scheduler`'s semantics (static declarations, catch up once, run history) don't fit per-user, per-device rows.
- No escalation of tone or volume between rings.
- No portal-editable alert settings. The three limits are environment settings, like `FRIDAY_IDLE_TIMEOUT_MS`.

## Decisions

### 1. Alerts live in core, as an `AlertService` with core-owned tools

`packages/core/src/alerts/` holds:
- `store.ts`: the `alerts` table, migration 8 in `storage/db.ts`;
- `service.ts`: `AlertService`, which fires, rings, waits and counts;
- `tools.ts`: `registerAlertTools(registry, alerts)`, which registers `set_timer`, `list_timers`, `cancel_timer` and `snooze_alert` with owner `core`;
- `tone.ts`: the opening tone.

`server.ts` creates the service next to `DeviceStore` and passes it to `attachAudioWs`, the new `attachDeviceWs`, the app (for `/api/alerts` and device deletion) and the shutdown path.

- **Why core:** alerts need the device connections, the audio sessions and core tables. All of that is core's, and a module can't reach it.
- **Alternative: an `alerts` module behind a new `ctx.alerts` SDK surface.** It would keep tools out of core, but it would add SDK API that only one module uses, for behaviour core has to implement anyway.
- **Alternative: keep the tools in `modules/builtin` and call into core.** The SDK has no channel for that.
- **Trade-off:** owner `core` tools don't appear under any module on the Modules page. They're still in the startup tool log and in `registry.list()`. Remote and MCP owners already set the precedent that owners aren't all modules.

### 2. Table and states

The `alerts` table (migration 8) has these columns:
- `id`: short random, 4 base32 characters, unique among non-final alerts, so the model can say it back;
- `kind`, `label`, `language`;
- `due_at`, `next_ring_at`;
- `target_kind`, `target_id`;
- `state`, `rings` (unanswered count), `local` (0/1, ringing on the device's own tone);
- `created_at`, `conversation_id`, `finished_at`.

Indexes: `(state, next_ring_at)` and `(target_kind, target_id, state)`.

`next_ring_at` is when the service should next try. It's set to `due_at` on create and snooze, and to `now + interval` after an unanswered ring. Storing it means a restart resumes the ring cycle instead of starting over.

```
            create / snooze
                 |
                 v
  +--------> scheduled --- due, device free & online ---> ringing --+--> acknowledged
  |              |                                         |  ^     |
  |  snooze      | cancel                       unanswered |  |     +--> cancelled
  +--------------+------------------------------ (rings<N) +--+     |
                 v                                                  +--> missed (rings>=N,
             cancelled                                                   local tone ran out,
                                                                         or grace passed
                                                                         before a ring started)
```

"Waiting" (the device offline, or in a conversation) isn't a stored state. It's a `ringing` alert whose ring can't be sent yet. The service re-checks it when the device comes online or its last audio socket closes.

### 3. One loop, event-driven re-checks

`AlertService` keeps a single `setTimeout` for the earliest `next_ring_at` among `scheduled`/`ringing` rows. The delay is capped at one hour, so clock drift and long timers are harmless. It's re-planned on every write. A tick:

1. marks `missed` every alert whose grace has passed and which isn't ringing locally or in an alert session (see decision 4);
2. groups the due alerts by device;
3. for each device that is online, has no open audio socket and has no ring in flight: sends one `ring` for one of its due alerts, sets the group's state to `ringing`, and starts the 15 s answer timer.

**Re-check triggers.** `DeviceLinks` (decision 6) and `DeviceSessions` raise "online" and "idle" (last audio socket closed). On either, the service ticks for that device right away. This covers "rings when the conversation ends" and "rings right after it connects".

**At startup:** the service resets `local` to 0, because the device will re-report it. It treats `ringing` rows as due now and runs a first tick. Rows past grace become `missed`, which gives "short restart rings, long outage is missed".

### 4. Grace limits when a ring may start, not one already in progress

The spec's grace rule is enforced when a ring is about to start. An alert session that is open, or a local tone the device reported, is never cut off by grace: cutting off a ring that's already sounding would surprise the user more than letting it finish. With the defaults, 5 rings 60 s apart fit well inside 10 minutes. Only a local tone that started late can run past grace. The `alerts` spec wording ("Late alerts are missed") is updated together with this design to say exactly this.

### 5. The alert session is a `GeminiSession` with two generic options

`SessionOptions` gains two fields:
- `opening?: { audio: Buffer; text: string }`. After `open()` resolves, the session emits `audio` events for the tone (in 100 ms chunks), then sends `text` with `sendClientContent` directly, not through `sendText`. So the opening turn is never recorded and doesn't count as the user taking their turn.
- `awaitUser?: { onFirstInput(): void }`. Until the first input transcription or `sendText`, the session:
  - drops end requests the same way the question rule does: it clears `endRequested` at turn completion and keeps `holdInterrupted`;
  - arms the idle timer with reason `ended: no answer`, using the default 8000 ms even when `FRIDAY_IDLE_TIMEOUT_MS` is 0.

  On the first input it calls `onFirstInput` once and behaves normally from then on.

`serveWs` reads `alert`. For a device connection it calls `alerts.claim(deviceId, alertId)`, which returns `undefined` (then `ws.close(4410, "alert gone")` before any Gemini session is created) or a claim with:
- the alerts it covers,
- the opening text,
- `acknowledge()`,
- `closed(reason)`.

The claim cancels the 15 s answer timer. `onFirstInput` calls `claim.acknowledge()`, and the session's `closed` event calls `claim.closed()`. When neither acknowledge nor snooze happened by then, the service counts one unanswered ring. A Gemini open failure also ends the claim, after `1011`: the device then rings locally and reports `ringing_locally`, which stops server rings.

- **Why options instead of an `AlertSession` subclass:** the end-request and idle rules are already intertwined inside `handle()`, and a subclass would have to reach into them. Two small options keep one code path and are easy to test with the existing fake Live connection.

### 6. `/ws/device` and `DeviceLinks`

`packages/core/src/transports/device-ws.ts` mounts `/ws/device` with `mountWs` and `keepAlive`, the same helpers `/ws/audio` uses.

**Authentication.** The authentication part of `serveWs` (read `device`, take the bearer key, call `authenticate`, close with its code) moves into a shared `authenticateDevice(ws, req, devices)` in `transports/device-auth.ts`. Both endpoints use it, so the spec's "authenticated exactly as `/ws/audio`" holds by construction. That includes pending attempts and the last-connected time.

**`DeviceLinks` (`packages/core/src/devices/links.ts`).** It holds at most one control socket per device: a new socket closes the old one with `4409 replaced`. It offers:
- `send(id, msg)`,
- `online(id)`,
- `onOnline(listener)`,
- `disconnect(id)`, which closes with `4401`.

`DeviceSessions.disconnect` callers (revoke, delete, replace key) call both. `DeviceSessions` gains `onIdle(listener)`.

**Frames from the device.** These are parsed defensively, like `/ws/audio` text, and routed to `alerts.deviceReport(id, type, alertId)`. That method ignores alerts that aren't ringing on that device.

**Alternative: a control mode on `/ws/audio` (`?control=1`).** It would mix two lifetimes (session sockets close on `closed`, control sockets never do) in one handler. It would also make every `/ws/audio` change risk the control channel.

### 7. Device id in the call context

`ToolCallContext` gains `device?: string`. `GeminiSession` gets the device id through a new `SessionOptions.device`, which `serveWs` sets from the authenticated snapshot, and passes it in `runTool`'s `callTool` options. Chat never sets it.

`snooze_alert` uses `context.device` to find the device's open alert claim. A device has at most one alert claim at a time. So the tool doesn't need the session's identity, only the device's.

### 8. Opening text and language

`set_timer` requires `language` (`nl` | `en`). The model knows which one the user is speaking, and the session prompt already frames Friday as Dutch-or-English. Storing it is cheaper and more reliable than detecting language from the stored transcript later.

The opening text is English instructions with the target language named, for example:

> Alert: the timer "eggs" (5 minutes, set at 12:00) went off at 12:05, 2 minutes ago. Tell the user briefly, in Dutch, and wait for their answer. If they want more time, call snooze_alert.

The text is built by a pure function with tests. Several alerts are listed in one text.

### 9. The tone

`tone.ts` synthesises 24 kHz s16le PCM once at startup: three rising two-note chimes (about 2 s), at about −12 dBFS with short fades so it doesn't click. It's pure code and tested for length and peak level. No audio asset ships in the image.

Sending the tone from the server means it arrives before Gemini's audio on the same socket. If Gemini reports `interrupted` because the user spoke, the device flushes the tone along with everything else.

### 10. Firmware: a second client for control, ringing as a state

In `friday_client` (both devices share it):

**Control client.** A second `esp_websocket_client` is created at setup once Wi-Fi is up. Its URL is derived from the configured `url` by replacing the trailing `/ws/audio` with `/ws/device`; an optional `control_url` overrides that. Auto-reconnect is disabled. `loop()` reconnects with the spec's backoff, using `close_code_`-style capture for `4401`/`4403`/`4409`. Control text frames reuse the existing size cap (4096). Events are handed to `loop()` through a small mutex-guarded queue of `(type, alert id)`, so all state changes stay on the main loop.

**`State::RINGING`.** It's added with `state_name` `ringing`.
- `ring` while idle and unmuted calls `start_alert_(id)`, which is `start()` with `&alert=<id>` appended and no chime.
- The alert id and a `got_audio_` flag are kept for the session.
- A close before the first audio frame, with `4410`, goes to idle. Any other code, or a connect timeout, goes to `ring_local_()`.
- `ring` while muted goes straight to `ring_local_()`.

**`ring_local_()`.**
- It keeps a small set of alert ids and sends `ringing_locally` for each.
- It queues `chime()` PCM with gaps through the player while in `RINGING`, which is the same output path, so AEC and volume apply.
- It stops on `stop_ringing_(acknowledged)`, on `stop` for the last alert, or after `ring_limit` (YAML option, default 5 min), and then sends `acknowledged` or `unanswered`.

**Button.** `toggle()` in `RINGING` calls `stop_ringing_(true)`. Ending an alert session with the button (`stop()` while an alert id is set) sends `acknowledged` first. The wake word is already only enabled in idle (the YAML `on_state` handler), so it's off while ringing.

**reSpeaker Mute button.** Because the XVF3800 toggles mute itself, the YAML `on_mute` handler does this while `friday_client` is ringing: it calls `stop_ringing(true)`, then restores the previous mute state with `xvf3800.mute`/`unmute`. To the user, the Mute button stops the ringing and mute is unchanged. Restoring mute takes one GPO poll, during which the mics may flip. That's harmless, because no session is open while ringing locally.

**Online sensor.** `is_online()` is exposed and the YAML adds a template `binary_sensor`. The LED `on_state` handlers in both YAMLs get a `ringing` pattern.

- **Alternative: one socket that is always open and also carries sessions.** That would rewrite the session lifecycle the firmware and the server both rely on, for no user-visible gain.

## Risks / Trade-offs

- **[Memory] A second TLS connection on the ESP32-S3.** → TLS buffers are already in PSRAM on both devices (`CONFIG_MBEDTLS_EXTERNAL_MEM_ALLOC`). The control client's buffers are small (4 KB text cap). Log free internal heap at control connect and verify on both devices before merging. The earlier out-of-memory crash came from large text frames, which devices no longer receive.
- **[False acknowledge] Background speech or TV during the announcement counts as an answer.** → This is accepted as the cost of hands-free "stop". Start-of-speech sensitivity is `LOW` and AEC removes the device's own audio. The conversation is recorded, so a false acknowledge is visible afterwards.
- **[The model announces in the wrong language or not at all.]** → The opening text is explicit and tested as a pure function. If the model calls nothing and says nothing, the idle timer still closes with `no answer` and the alert rings again.
- **[A ring while the user starts talking with the wake word.]** → `ring` is ignored when the device isn't idle. The server sees no claim within 15 s, counts an unanswered ring, and the "idle" re-check rings again right after that conversation. In practice the server also holds rings while an audio socket is open, so this is a narrow race.
- **[Gemini Live cost of rings that nobody answers.]** → Each ring is at most the tone, the announcement and an 8 s listen window. Five rings is roughly a minute of Live audio per missed alert.
- **[Clock jumps or a long event-loop stall.]** → The loop compares against wall-clock `next_ring_at` on every tick and caps timeouts at an hour, so a late tick just rings late, within grace.
- **[Tools owned by `core`.]** → These are the first core-owned tools. `registry.list()` and the startup log show them. `/api/modules` doesn't, which is acceptable for now.

## Migration Plan

1. Deploy core first. Migration 8 creates `alerts`. Old firmware keeps working for conversations. Its devices show as offline in the portal, and `set_timer` refuses there with the firmware message.
2. Reflash the Voice PE and the reSpeaker over OTA. Each comes online on its first boot, and their device keys are unchanged.
3. Rollback: redeploy the previous image. The `alerts` table is ignored by older code, and any scheduled timers simply don't ring. New firmware against an old core keeps reconnecting its control client every 60 s after a 404/close. Its sessions keep working, because `/ws/audio` ignores the unknown `alert` parameter.

## Open Questions

- The exact tone (notes, number of repeats) and the LED `ringing` pattern colours. These are tuned on the devices and don't affect the specs or tasks.
