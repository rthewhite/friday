# Design

## Context

See proposal.md for motivation. Facts that shape the approach:

- The Voice PE is an ESP32-S3 (16 MB flash, PSRAM) running ESPHome on ESP-IDF. Audio does not go straight to the ESP32: an XMOS XU316 does beamforming and acoustic echo cancellation and presents a stereo 16 kHz 32-bit I2S stream to the ESP32 (`i2s_input`, GPIO13/14/15). Output is a 48 kHz 32-bit stereo I2S stream (`i2s_output`, GPIO7/8/10) into an AIC3204 DAC. The XMOS needs its firmware loaded over I2C by the `voice_kit` component at boot. The centre button is GPIO0, the dial a rotary encoder on GPIO16/18, the hardware mute switch GPIO3, and the LED ring 12 WS2812 on GPIO21.
- The official firmware already configures all of the above. It layers a `mixer` speaker and two `resampler` speakers on the I2S speaker so that arbitrary-rate 16-bit audio can be played.
- ESPHome exposes `microphone::Microphone` (`start`, `stop`, `add_data_callback(const std::vector<uint8_t>&)`), `microphone::MicrophoneSource` (channel selection, 32 to 16-bit conversion, gain, per-consumer enable) and `speaker::Speaker` (`start`, `stop`, `finish`, `play(data, len, ticks_to_wait)`, `has_buffered_data`, `set_audio_stream_info`). External components live in a local directory and reference configured components by id through `cv.use_id`.
- Friday's server speaks raw WebSocket: binary 16 kHz s16le mono in, binary 24 kHz s16le mono out, JSON events in text frames. See `openspec/specs/audio-transport/spec.md`.
- ESP-IDF has a managed `espressif/esp_websocket_client` component (RFC 6455, binary and text frames, runs in its own task, event callbacks). ESPHome can pull registry components in via `esp32.framework.components`.

## Goals / Non-Goals

**Goals:**
- Reuse the official Voice PE ESPHome config for everything hardware related; add Friday as a component on top rather than rewriting the audio stack.
- Never touch I2S, the XMOS or the DAC from the custom component. Consume audio only through ESPHome's `Microphone` and `Speaker` abstractions so echo cancellation, the mute switch and volume keep working.
- Keep session logic in C++ and presentation (LEDs, sounds) in YAML, following ESPHome idiom.
- Leave a slot for device identity and credentials on connect without implementing either.

**Non-Goals:**
- Wake word, Home Assistant voice pipeline, TTS announcements or media player from HA.
- Any change to `GeminiSession`, tools, or the browser client.
- TLS, authentication, reconnection with session resume.

## Decisions

### 1. Fork the official YAML and strip the voice pipeline, keep the rest

Start from `home-assistant-voice.yaml` and remove `voice_assistant`, `micro_wake_word`, the HA `media_player` and their scripts. Keep `esp32`, `psram`, `wifi`, `api`, `ota`, `logger`, `voice_kit`, `i2s_audio`, `microphone`, `speaker` (I2S plus mixer plus resampler), `audio_dac`, `light`, the button, dial and mute switch, and the LED effect partitions.

*Why:* the XMOS firmware load, I2S pinout and LED partitions are fiddly and already correct upstream. Keeping `api:` means the device still shows up in Home Assistant for OTA, logs and, later, room metadata. The resampler speaker is exactly what we need for 24 kHz playback into a 48 kHz output.

*Alternative:* a minimal YAML from scratch. Smaller file, but re-deriving the audio pinout and XMOS setup is where a project like this loses a week.

### 2. A `friday_client` external component that owns the session state machine

Directory `esphome/components/friday_client/` with `__init__.py`, `friday_client.h/.cpp`. YAML:

```yaml
friday_client:
  id: friday
  url: ws://${friday_host}:${friday_port}/ws/audio
  device_id: ${name}          # sent as a query parameter, unused by the server today
  microphone: friday_mic      # a microphone_source: i2s_mics, channel 0, 16 bit
  speaker: friday_speaker     # a resampler speaker feeding the mixer
  on_state: ...               # trigger with the new state for LEDs
```

The component holds a state machine: `IDLE → CONNECTING → LISTENING ⇄ SPEAKING → IDLE`, plus `ERROR` which returns to `IDLE` after a short delay. Exposed actions: `friday_client.toggle`, `friday_client.start`, `friday_client.stop`. The YAML wires the button's single click to `toggle` and `on_state` to the existing LED scripts.

*Why:* the state machine has real concurrency (three FreeRTOS tasks touch it) so it belongs in C++. LEDs and sounds are taste, and taste belongs in YAML where the user can change it without recompiling C++.

### 3. Microphone via `microphone_source`, one channel, 16-bit

Configure a `microphone_source` on `i2s_mics` selecting channel 0 with 16-bit output. The component registers a data callback and forwards the bytes. XMOS already did echo cancellation and beamforming, so one channel is enough and no processing happens on the ESP32.

*Why:* `MicrophoneSource` does the 32 to 16-bit conversion and per-consumer enable for free, and using the `Microphone` abstraction means the hardware mute switch and other consumers keep working.

*Alternative:* register directly on `i2s_mics` and convert ourselves. More code, same result.

### 4. Speaker via a dedicated `resampler` speaker into the mixer

Add a third mixer input, `friday_mixing_input`, and a `resampler` speaker `friday_speaker` in front of it. Before the first `play`, the component calls `set_audio_stream_info({24000, 1, 16})` so the resampler upsamples to 48 kHz stereo. Server binary frames are passed to `play()` with a bounded wait; if the buffer is full for longer than that the frame is dropped and a warning logged.

Events: on `interrupted`, call `stop()` then `start()` on `friday_speaker` to flush. On `closed`, call `finish()` so queued speech drains, then go idle when `has_buffered_data()` is false or after a timeout.

*Why:* mirrors the browser client's flush and drain behaviour with two method calls, and the mixer keeps the existing volume, mute and DAC handling intact.

### 5. WebSocket via `esp_websocket_client` from the component registry

Pull `espressif/esp_websocket_client` through `esp32.framework.components`. The client task delivers events (`CONNECTED`, `DATA`, `CLOSED`, `ERROR`) to a callback in the component. Binary data goes to the speaker path; text data is parsed with ESPHome's `json` component and only `interrupted`, `turn_complete` and `closed` are acted on. Transcript and tool events are ignored.

*Why:* it is the maintained IDF client, handles fragmentation and ping/pong, and avoids adding a third-party Arduino library to an IDF build.

### 6. Decoupled microphone send path

The microphone callback runs in the microphone task and must not block on the network. It copies frames into a FreeRTOS ring buffer (PSRAM). A dedicated sender task drains the buffer in 100 ms chunks (3200 bytes) and calls `esp_websocket_client_send_bin`. If the buffer overflows the oldest audio is dropped.

*Why:* Wi-Fi stalls of a few hundred milliseconds are normal; dropping late audio is better than glitching capture. 100 ms frames cut WebSocket overhead versus the browser's 20 ms without hurting Gemini's turn detection noticeably.

### 7. Connect URL carries device identity, nothing else yet

The device connects to `/ws/audio?device=<device_id>`. The server parses and logs the parameter and otherwise ignores it. A future credential goes in an `Authorization` header or a `token` query parameter next to it.

*Why:* this is the slot the proposal asks for. Query parameters cost nothing on the device and are trivially available in the upgrade request on the server. Headers are also possible with `esp_websocket_client` if we prefer them for the credential later.

### 8. Server keep-alive

`WebSocketServer` gets a 20 second ping interval; a connection that misses a pong is terminated, which closes the Gemini session through the existing `close` handler. `maxPayload` stays at the `ws` default, which is far above any frame we send.

*Why:* an ESP32 that loses Wi-Fi does not send a close frame, and today that would leave a Gemini session open until Gemini itself times out.

### 9. Button semantics

Single click toggles: `IDLE → start`, anything else `→ stop`. Long press, double and triple click keep their upstream meanings (or are removed) but do not touch Friday. The hardware mute switch is honoured by ESPHome's microphone mute, and the component additionally refuses to `start` while muted and shows the error state.

## Risks / Trade-offs

- [The `resampler` speaker or `MicrophoneSource` API differs between ESPHome versions] → pin the ESPHome version in the YAML and the README; the component compiles against one known release.
- [`esp_websocket_client` conflicts with ESPHome's own IDF component set or version] → it is a registry component with no ESPHome overlap; verify on the first build and fall back to the older `esp_websocket_client` bundled in some IDF versions.
- [Playback underrun on Wi-Fi jitter causes choppy speech] → the resampler and mixer buffers absorb some; increase `buffer_duration` on `friday_speaker` if needed. Trade-off is added latency before speech starts.
- [Gemini's server-side VAD reacts to the device's own speech] → the XMOS echo cancellation covers this only because output flows through the same DAC path; anything that bypasses the mixer would break it, so all playback must go through `friday_speaker`.
- [Session ends abruptly when Wi-Fi drops] → accepted for now; the device returns to idle and the server's ping timeout cleans up. No resume, since the Gemini session is gone anyway.
- [Forking the upstream YAML means upstream fixes do not arrive automatically] → keep the fork thin and record the upstream commit it was taken from in a comment at the top.

## Migration Plan

1. Build with `esphome compile esphome/friday-voice-pe.yaml` on the development machine; flash the first time over USB with `esphome run`, later over OTA.
2. The server change is backwards compatible; deploy it before flashing.
3. Rollback: flash the official Home Assistant Voice PE firmware from the ESPHome web installer. Nothing on the device is persisted by this change.

## Open Questions

- Microphone chunk size and speaker `buffer_duration` are tuning values; set defaults in the YAML and adjust after listening tests.
- Whether to keep the upstream double, triple and long press automations or remove them for a cleaner config. Either works with this design.
