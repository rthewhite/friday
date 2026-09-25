# Proposal

## Why

Friday only runs in a browser tab today, which makes it a demo rather than an assistant. The Home Assistant Voice Preview Edition (Voice PE) is an ESP32-S3 speaker with a microphone array, a top button and an LED ring, sitting on a shelf and always powered. Hooking it up turns Friday into a room device, and the existing WebSocket audio protocol was designed for exactly this client. Starting with press-to-talk keeps the first iteration small; wake word detection is a later change.

## What Changes

- Add an ESPHome configuration for the Voice PE with a custom external component (`friday_client`) that speaks Friday's `/ws/audio` protocol directly, bypassing the Home Assistant voice pipeline.
- Pressing the top button opens a WebSocket session to the Friday server and streams 16 kHz mono s16le microphone audio. Pressing it again ends the session.
- Audio from the server (24 kHz mono s16le) is played through the on-board speaker; JSON `interrupted` events flush the playback buffer; `closed` events stop the microphone but let queued audio finish, matching the web client.
- The LED ring reflects session state (idle, connecting, listening, speaking, error) so the user can tell what Friday is doing without a screen.
- Server: keep the device alive across the ESP32's slower connect and add the small protocol accommodations the device needs (WebSocket ping/pong keep-alive, tolerance for larger binary frames). No change to tools, session logic, or the browser client.
- Documentation for flashing the config, pointing it at the server, and troubleshooting.
- Out of scope: wake word, Home Assistant voice pipeline integration, multiple devices per server, per-device metadata, device authentication, TLS on the device.

## Future Direction (not in this change)

Several Voice PE devices will eventually connect to one Friday server, each carrying metadata such as the room it is in, so Friday can use that as context ("turn on the lights" means the lights in that room). This change does not implement any of it, but the design should not block it: the device config should have an obvious place for an identifier and metadata, and the protocol should have an obvious place to carry them on connect, even if both stay unused for now.

Devices will also need to authenticate eventually, likely through an onboarding flow in a web portal that registers a new device and hands it a per-device API key. For now the WebSocket is unauthenticated on a trusted LAN. The design should keep a place for a credential on connect (for example a header or first message alongside the device identifier) so authentication can be added without changing the audio framing.

## Capabilities

### New Capabilities

- `voice-pe-client`: firmware behaviour of the Voice PE running Friday: button-driven session lifecycle, microphone capture and streaming, speaker playback and interrupt handling, LED state feedback, reconnection and error behaviour, and configuration of the server address.

### Modified Capabilities

- `voice-session`: once the model has called `end_conversation`, the session no longer forwards Gemini's `interrupted` flag, so clients play the final words instead of flushing them.
- `audio-transport`: the WebSocket protocol gains explicit keep-alive behaviour (server responds to pings and closes dead connections) and documents frame size limits so microcontroller clients can rely on them. Existing browser behaviour is unchanged.

## Impact

- **New**: `esphome/` directory with the Voice PE YAML config and the `friday_client` external component (C++), plus a README section.
- **Modified**: `src/transports/ws.ts` for keep-alive and frame limits; `src/server.ts` if the WebSocket server needs options for `maxPayload` or ping intervals; `.env.example` for any new server knobs.
- **Unchanged**: `GeminiSession`, the tool registry, all tools, and `web/`.
- **Dependencies**: ESPHome 2025.x toolchain on the development machine; a WebSocket client library for ESP-IDF inside the component (the ESP-IDF `esp_websocket_client`). The Voice PE needs to reach the Friday server on the LAN over plain `ws://`.
- **Risk**: the Voice PE's ESPHome audio stack (microphone, speaker, I2S) is the part most likely to fight a custom component. The design phase should confirm we can take exclusive ownership of the I2S mic and speaker while ESPHome still handles Wi-Fi, OTA and the button.
