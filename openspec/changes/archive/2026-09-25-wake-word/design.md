# Design

## Context

See proposal.md for motivation. Constraints from the current code and ESPHome 2026.9:

- `friday_client` (from the archived `voice-pe-client` change) owns the session state machine with states idle, connecting, listening, speaking, error, exposes `start`, `stop`, `toggle`, `error` actions and an `on_state` trigger, and plays server audio through a generation-flushed queue into the `friday_speaker` resampler. It consumes microphone channel 0 through a `MicrophoneSource`.
- ESPHome's `micro_wake_word` runs one or more streaming models on a `MicrophoneSource` of its own, has `start`/`stop`, `enable_model`/`disable_model` actions, `is_running` and `model_is_enabled` conditions, and an `on_wake_word_detected` trigger. Models can be referenced by official name, URL, or `github://owner/repo/path@ref` shorthand, and a model marked `internal: true` is hidden from Home Assistant.
- The I2S microphone reference-counts listeners, so the wake word engine and the Friday client can start and stop their sources independently without cutting each other off. The upstream firmware fed its wake word engine from channel 1 with gain 4 while the voice pipeline used channels 0 and 1.
- `speaker.play` in YAML only accepts inline byte arrays. Playing a file needs the `media_player` and `audio_file` stack that was removed from this config.
- Wake word models are pulled in at build time and compiled into the firmware; `micro_wake_word` adds `esp-tflite-micro` and `esp-micro-speech-features` as IDF components.

## Goals / Non-Goals

**Goals:**
- Hands-free start with "hey friday", with the button still working as before. Hands-free stop already works through Gemini.
- No changes to the session state machine or the server protocol; the wake word is just another caller of `friday_client.start` and `friday_client.stop`.
- A perceptible chime on detection with no new audio pipeline.
- Model swappable by editing one YAML line.

**Non-Goals:**
- Training or improving a model, sensitivity selection, a Home Assistant switch to disable the wake word, LED patterns beyond the existing states.

## Decisions

### 1. Detection runs in YAML via `micro_wake_word`; the component stays unaware of wake words

`micro_wake_word` is configured with the `hey_friday` model from `github://JohnnyPrimus/Custom_V2_MicroWakeWords/models/hey_friday/hey_friday.json@<pinned commit>`. `on_wake_word_detected` plays the chime then calls `friday_client.start`. The engine also gets the default `vad:` model, as upstream did, to suppress triggers on non-speech noise.

A local `stop` model was tried and removed: in every test Gemini heard "stop" through barge-in and ended the session itself (the system prompt asks it to), before the local model fired. Two detectors for one word add inference load for no behaviour.

*Why:* the component's job is the Friday protocol. Wake word is device policy and belongs in YAML where the model, phrase and reactions can be changed without recompiling C++. It also keeps the component reusable for a future ESP32 client without a wake word.

*Alternative:* have the component own a `micro_wake_word` reference and start itself. Tighter, but couples two components for no gain.

### 2. Model gating follows session state through `on_state`

`micro_wake_word` runs continuously. The existing `on_state` automation enables `hey_friday` when the device is idle and disables it in every other state. `on_boot` enables it and starts the engine. A detection can therefore never restart a running session.

*Why:* enabling and disabling a model is cheap and instant; stopping and starting the engine costs a mic restart. Keeping the engine running also means the mic is always on, which is what a wake word device is anyway.

### 3. Both the wake word engine and Friday listen on XMOS channel 1

The XMOS `voice_kit` defaults are channel 0 at the AGC stage and channel 1 at the NS stage. Both are echo-cancelled, but channel 0's automatic gain control amplifies the residual echo of Friday's own voice until Gemini transcribes it ("Once upon a") and interrupts the reply. Friday therefore moves from channel 0 to channel 1; the wake word engine uses channel 1 with gain 4 as upstream did. Both sources share the same I2S microphone.

*Why:* found during device testing of this change (long replies stuttered every few seconds). The upstream Home Assistant pipeline never depended on echo cancellation during playback because it does not listen while text-to-speech plays, so it never exposed this.

### 3b. Barge-in guard at the start of each reply

Even on channel 1 the first second of each reply leaks while the echo canceller re-converges after silence. The component sends silence instead of microphone audio for a configurable `barge_in_delay` (default 1.5 s) after entering the speaking state, then streams normally. The server also asks Gemini for low start-of-speech sensitivity and a 200 ms minimum speech duration (`FRIDAY_VAD_START_SENSITIVITY`, `FRIDAY_VAD_PREFIX_MS`).

*Why:* the leak is confined to a predictable window; gating that window preserves barge-in for the rest of the reply. Alternatives considered: keeping the output pipeline running between turns so the canceller stays converged (untested, and the first reply of a session would still leak); attenuating the microphone for the whole reply (hurts barge-in everywhere instead of for one second).

### 4. Chime is synthesised in the component and played through the normal queue

Add a `friday_client.chime` action. The component generates a short two-tone signal (roughly 200 ms, 24 kHz mono, fade in and out) and pushes it onto the existing playback queue with the current generation. The player task starts the speaker if needed, so the chime plays while the WebSocket is still connecting.

*Why:* no audio files, no `media_player`, no second pipeline, and the sound goes through the same path as speech so echo cancellation and volume apply. It costs a few dozen lines of C++ and no flash for assets. The queue-based design already handles "chime then speech" ordering and flush on interrupt.

*Alternatives:* embed a WAV as an inline byte array with `speaker.play` (kilobytes of hex in YAML, ugly to change); reinstate `audio_file` and `media_player` (a whole pipeline for one beep).

### 5. Mute blocks detection in YAML

`on_wake_word_detected` for `hey_friday` is wrapped in `if: switch.is_off: master_mute_switch`. The hardware switch already cuts the microphones, so this covers the software mute exposed to Home Assistant. `friday_client.start` keeps its own mute check as a second line of defence.

### 6. Button behaviour unchanged; button does not chime

The wake word is the case where the user needs acoustic confirmation that they were heard. A button press has tactile feedback and the LED ring. Adding a chime there later is one YAML line.

### 7. Pin the community model to a commit

The model URL uses `@<sha>` so a rebuild reproduces the same firmware. Upgrading the model is an explicit edit. Record the sha and the source thread in a YAML comment.

### 9. Playback queue sized for a whole reply

Gemini streams speech two to three times faster than it plays. The socket task must not block (it would starve the microphone sender), so instead of backpressure the playback queue in PSRAM holds about 65 s of audio (3 MB of the 8 MB). A reply longer than that at burst speed would still drop, which is logged.

*Why:* found during testing of this change: a story overflowed the previous 4 s queue and played as static. Alternative: blocking the socket task until space frees up, rejected because it reintroduces the microphone starvation fixed in the previous change.

## Risks / Trade-offs

- [Community "hey friday" model misses or false-triggers] → tune `probability_cutoff` in YAML first; then try channel 0 or a different gain; then swap to `hey_jarvis` by changing the model line. The VAD model reduces noise triggers.
- [Barge-in within the first 1.5 s of a reply is ignored] → accepted; the user rarely interrupts before Friday has said a word, and the button and stop word still work.
- [Always-on microphone changes the privacy posture] → detection is on-device; audio only leaves the device after the wake word. Document this in the README.
- [Firmware size and RAM grow with TFLite Micro and two models plus VAD] → upstream ran three wake models plus VAD on the same hardware; current build sits at 16% flash and 40% RAM.
- [Two `MicrophoneSource`s on one microphone] → supported by design in ESPHome (listener reference counting); verified by the upstream firmware running the voice pipeline and wake word together.
- [Chime overlaps the first words of a reply if the server answers within 200 ms] → not possible in practice: connect plus Gemini's first audio takes seconds. If it ever does, the queue plays them in order anyway.

## Migration Plan

1. Update the YAML and component, `esphome run` over the air; the server is untouched.
2. Rollback: revert the YAML to the archived `voice-pe-client` version and flash; nothing persists on the device.

## Open Questions

- Chime tone and length are taste; ship a default and adjust after hearing it. Does not affect specs or tasks.
- Whether the wake word should also fire while the ring shows error (currently disabled until idle, two seconds later). Either is acceptable and is a one-line table change.
