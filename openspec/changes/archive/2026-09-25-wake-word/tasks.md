# Tasks

## 1. Chime in the component

- [x] 1.1 Add a `chime()` method to `FridayClient` that synthesises a short two-tone 24 kHz mono signal with fade in/out and enqueues it on the playback queue with the current generation; register a `friday_client.chime` action in `__init__.py`; verify `esphome compile` succeeds
- [x] 1.2 Bind a temporary test: call `friday_client.chime` from a long press, flash OTA, and verify the chime is audible at dial volume while idle, then remove the binding

## 2. Wake word engine in the YAML

- [x] 2.1 Add `micro_wake_word` with `hey_friday` from `github://JohnnyPrimus/Custom_V2_MicroWakeWords/models/hey_friday/hey_friday.json@<sha>` (record the sha and source thread in a comment), the default `vad:`, microphone channel 1 with gain 4; verify `esphome config` succeeds and `esphome compile` reports flash and RAM still comfortably under budget
- [x] 2.2 Wire `on_wake_word_detected`: for `hey_friday`, if `master_mute_switch` is off then `friday_client.chime` followed by `friday_client.start`; verify `esphome config` succeeds
- [x] 2.3 Add model gating to `friday_client.on_state` (idle: hey_friday on; otherwise off) and to `on_boot` (hey_friday on, `micro_wake_word.start`); verify `esphome config` succeeds and the automation reads as the table in design.md

## 3. Device verification

- [x] 3.1 Flash OTA and verify from the log that `micro_wake_word` starts at boot with `hey_friday` enabled, and that both the wake word engine and Friday share `i2s_mics` without errors
- [x] 3.2 Say "hey friday" while idle: verify the chime plays, the ring goes to connecting then listening, and the server logs `[friday-voice] session open`
- [x] 3.3 Say "hey friday" again while connecting, listening, and speaking: verify the session is unaffected and only one session exists on the server
- [x] 3.4 Local "stop" model removed: Gemini ends the session on "stop" via barge-in and the system prompt, verified twice in the server log (`user said stop`)
- [x] 3.5 Turn on the Mute switch in Home Assistant (or via the exposed entity) and say "hey friday": verify no session starts; flip the hardware switch and verify the same
- [x] 3.6 Leave the device idle for ten minutes in a room with normal conversation and TV: count false triggers and, if more than one, tune `probability_cutoff` (or channel/gain) and re-verify; record the final values in a YAML comment
- [x] 3.7 Press the button to start: verify no chime plays and the session behaves as before

## 4. Documentation

- [x] 4.1 Update the README Voice PE section: usage ("hey friday"; "stop" or talking over Friday to interrupt), the always-on microphone and on-device detection note, how to swap the model, and troubleshooting for false triggers and missed detections; verify the documented model swap works by pointing at `hey_jarvis`, compiling, and pointing back

## Notes

- 3.6: soak of ~10 minutes on 2026-09-25 with room noise, zero false triggers at the model default cutoff 0.66. Detections in use scored 0.67 to 0.75; if misses appear, lower the cutoff toward 0.55.
