# Tasks

## 1. Server: keep-alive, device identifier, frame size

- [x] 1.1 Add a `test` script using `node --test` with `tsx` and a first WebSocket test harness that starts the server on a random port with a stubbed `GeminiSession`; verify `npm test` runs and passes an empty smoke test
- [x] 1.2 Parse the `device` query parameter in `serveWs` (from the upgrade request URL), include it in the session open and close log lines, and ignore unknown parameters; verify with a test that connects to `/ws/audio?device=kitchen&x=1` and asserts the connection is accepted and the log contains `kitchen`
- [x] 1.3 Add a server ping interval (default 20 s, configurable via `FRIDAY_WS_PING_MS`, 0 disables) that terminates connections without a pong before the next ping, and confirm termination closes the Gemini session; verify with a test using a short interval and a client that suppresses pongs, asserting the socket is terminated and the stub session's `close` is called
- [x] 1.4 Verify binary frame size acceptance with a test that sends a 32,000 byte binary frame and a sequence of 3,200 byte frames and asserts each reaches the stub session's `sendAudio` intact
- [x] 1.5 Document `FRIDAY_WS_PING_MS` in `.env.example` and add the `device` query parameter and ping behaviour to the protocol comment in `src/transports/ws.ts` and the Transport section of the README; verify `npm run typecheck` and `npm test` pass

## 2. ESPHome scaffold

- [x] 2.1 Create `esphome/friday-voice-pe.yaml` by copying the upstream `home-assistant-voice.yaml` at a recorded commit and removing `voice_assistant`, `micro_wake_word`, the HA `media_player`, and their scripts and substitutions, keeping XMOS, I2S, DAC, LEDs, button, dial, mute switch, `api`, `ota`, `logger`, `wifi`; verify `esphome config esphome/friday-voice-pe.yaml` succeeds
- [x] 2.2 Add `esphome/secrets.yaml.example` (Wi-Fi, API key, OTA password) and gitignore `esphome/secrets.yaml` and `esphome/.esphome/`; verify `git status` shows only the example file
- [x] 2.3 Add `substitutions` for `name`, `friday_host` and `friday_port` and pull `espressif/esp_websocket_client` into the build via `esp32.framework.components`; verify `esphome compile esphome/friday-voice-pe.yaml` links successfully with no component yet
- [x] 2.4 Add a `microphone_source` (`i2s_mics`, channel 0, 16-bit) named `friday_mic`, a third mixer input `friday_mixing_input`, and a `resampler` speaker `friday_speaker` feeding it; verify `esphome config` succeeds and the mixer lists three inputs

## 3. `friday_client` component: skeleton and state machine

- [x] 3.1 Create `esphome/components/friday_client/` with `__init__.py` (schema: `url`, `device_id`, `microphone`, `speaker`, `on_state` trigger; `DEPENDENCIES = ["microphone", "speaker", "json"]`) and empty `friday_client.h/.cpp` that compile; verify `esphome compile` with the component declared in the YAML
- [x] 3.2 Implement the state enum (IDLE, CONNECTING, LISTENING, SPEAKING, ERROR), a mutex-guarded `set_state_` that fires `on_state`, and the `start`, `stop`, `toggle` actions with ERROR auto-returning to IDLE after 2 s; verify by wiring `on_state` to a `logger.log` and observing the transitions in `esphome logs` when calling the actions from a test button
- [x] 3.3 Register `friday_client.start`, `friday_client.stop`, `friday_client.toggle` as ESPHome actions in `__init__.py`; verify the YAML validates when the centre button's single click calls `friday_client.toggle`

## 4. `friday_client` component: WebSocket connection

- [x] 4.1 Implement connect using `esp_websocket_client` with the URL `<url>?device=<device_id>`, a bounded connect timeout, and event handling for CONNECTED, DATA (binary and text), CLOSED and ERROR that drives the state machine (CONNECTED → LISTENING, failures → ERROR); verify against the local server that pressing the button logs `open` on the server with the device id and the LED trigger shows listening
- [x] 4.2 Implement `stop` so that in CONNECTING it aborts the connect and in any active state it sends a WebSocket close, stops the microphone and returns to IDLE; verify on device that a second press returns to idle and the server logs `client closed`
- [x] 4.3 Parse text frames with the `json` component and dispatch `interrupted`, `turn_complete`, `closed`; ignore all other types silently at debug log level; verify by sending each event type from a test script to the device (using a fake server) and checking the log shows only the handled ones acting

## 5. `friday_client` component: audio paths

- [x] 5.1 Implement the microphone send path: a PSRAM ring buffer fed from the `microphone_source` data callback, a sender task draining 100 ms (3,200 byte) chunks via `esp_websocket_client_send_bin`, oldest-first drop on overflow with a rate-limited warning; verify the server receives frames of 3,200 bytes and speech is transcribed (`user_text` visible in server logs)
- [x] 5.2 Refuse `start` when the microphone is muted and enter ERROR; keep capture running in both LISTENING and SPEAKING; verify on device that starting with the mute switch on shows the error pattern, and that speaking over Friday produces an `interrupted` event in the server log
- [x] 5.3 Implement playback: on first binary frame set the speaker stream info to 24 kHz mono 16-bit and start the speaker, `play()` with a bounded wait and drop-with-warning on full buffer, transition to SPEAKING on first frame and back to LISTENING when `turn_complete` has arrived and the speaker has no buffered data; verify Friday's reply is audible through the device speaker at the dial volume and the LED returns to listening after the reply
- [x] 5.4 Implement `interrupted` as speaker `stop()` then `start()` with immediate transition to LISTENING; verify by interrupting mid-sentence that audio cuts within roughly a quarter second
- [x] 5.5 Implement `closed` as stop microphone, speaker `finish()`, wait for drain with a 5 s cap, close socket, IDLE; implement unexpected socket close as stop microphone, speaker `stop()`, ERROR; verify that saying "goodbye" lets Friday finish speaking before the LEDs go off, and that killing the server mid-session shows the error pattern and then idle

## 6. LEDs and YAML polish

- [x] 6.1 Wire `on_state` to LED scripts: off for idle, a spinning pattern for connecting, the upstream waiting-for-command pattern for listening, the upstream replying pattern for speaking, red flash for error; verify each state is visually distinct on the device while walking through a session
- [x] 6.2 Decide and apply whether upstream long, double and triple press automations stay; ensure none of them touch Friday; verify a long press does not change Friday state
- [x] 6.3 Confirm the Home Assistant API, OTA and logger still work: adopt the device in HA, push an OTA update, tail logs; verify all three succeed and no voice assistant entity is offered

## 7. Documentation and integration check

- [x] 7.1 Add a "Voice Preview Edition" section to the README: prerequisites, copying `secrets.yaml.example`, setting substitutions, first USB flash, OTA afterwards, LED meaning table, troubleshooting (server unreachable, mute switch, choppy audio and `buffer_duration`); verify the documented commands run as written on a clean checkout
- [x] 7.2 End-to-end check against the spec scenarios: start, talk, interrupt, let Friday end the conversation, manual stop, mute, server unreachable, Wi-Fi drop; verify each observable outcome matches `specs/voice-pe-client/spec.md` and note any deviations in the change before archiving

## Notes

- 6.3: OTA and network logging verified on 2026-09-25. Home Assistant re-adoption with the new API key was left to the owner and not observed.
- 7.2: All scenarios verified on the device on 2026-09-25 except a Wi-Fi drop mid-session, skipped by decision. The server-side ping timeout that handles it is covered by the transport tests.
