# Proposal

## Why

Friday has one satellite, the Voice PE. The second, a Seeed reSpeaker XVF3800 4-mic array with an onboard XIAO ESP32-S3, is the device the voice-device onboarding was built for, but it has no firmware yet. Its XMOS XVF3800 does beamforming and echo cancellation on four mics, so it can be a room satellite as good as the Voice PE. It only needs an ESPHome configuration that speaks Friday's protocol and drives the board's own hardware.

## What Changes

- **New ESPHome configuration** `esphome/friday-respeaker.yaml` for the reSpeaker XVF3800 with XIAO ESP32-S3. The ESP32 is the I2S secondary of the XVF3800 at 48 kHz / 32-bit stereo in both directions. Wi-Fi, Home Assistant API (no voice pipeline, `reboot_timeout: 0s`), OTA and logging are set up as on the Voice PE.
- **Reuses `friday_client` unchanged.** The session lifecycle, device key and fingerprint, `wss://`, pending state, barge-in delay, chime and the protocol handling are the Voice PE's. The satellite onboards under Settings > Voice devices like any other device.
- **Wake word only.** "Hey friday" (the Voice PE's pinned `micro_wake_word` model) starts a session, and Friday ends it (`closed`). The board has no button the ESP32 can read except Mute, so there is no press-to-talk.
- **Mute.** The board's Mute button mutes the microphones in the XVF3800 and lights the red mute LED, as the XVF firmware does natively. The firmware reads the mute state over I2C, refuses to start a session while muted, and exposes a Mute switch in Home Assistant that drives the same XVF mute.
- **New `xvf3800` ESPHome component** (own, minimal, I2C at `0x2C`) with these parts:
  - It checks the XVF3800 firmware version at boot.
  - It applies the runtime settings at every boot: output routing for the two I2S channels, amplifier on, LED ring power on.
  - It reads and sets mute.
  - It provides a 12-LED addressable `light` platform for the ring the XVF3800 drives, so LED patterns stay YAML effects as on the Voice PE.
- **Firmware requirement.** The XVF3800 must run Seeed's public `respeaker_xvf3800_i2s_master_v1.0.9_48k.bin`, flashed once by hand over USB with `dfu-util` in safe mode (documented). The ESPHome firmware does not flash the XVF3800. If the version is wrong or the chip does not answer, it logs the problem, shows it in Home Assistant and refuses to start sessions.
- **New `decimating` microphone platform** (own ESPHome component) that turns the 48 kHz I2S stream into 16 kHz with a low-pass FIR. `friday_client` and `micro_wake_word` both need 16 kHz, and ESPHome 2026.9 has no resampling microphone. ESPHome's upstream `resampler` microphone (merged after 2026.9) can replace it later.
- **Playback** goes through a resampler speaker into a mixer into the I2S output, as on the Voice PE. The XVF3800 takes that stream as its echo reference and drives the DAC and the onboard amplifier for the JST speaker. Volume is software volume on the I2S speaker, set from a Home Assistant number entity and kept across restarts (there is no dial).
- **Docs:** README section for flashing the XVF3800 firmware, building and flashing the ESPHome firmware, and onboarding.

Out of scope:
- updating the XVF3800 firmware from ESPHome,
- direction-of-arrival LEDs and beam locking,
- the 3.5 mm jack as output,
- Home Assistant voice pipeline and media player,
- arbitration when two satellites hear the same wake word,
- tuning AEC parameters beyond the documented routing defaults, unless the hardware test shows barge-in or echo problems.

## Capabilities

### New Capabilities
- `respeaker-client`: firmware behaviour of the reSpeaker XVF3800 running Friday. It reuses the Voice PE's session, audio and identity behaviour from `voice-pe-client`. It adds wake-word-only control, XVF3800 mute (button, LED, Home Assistant switch), the firmware version check, LED ring states, 16 kHz capture from the 48 kHz I2S stream, and volume without a dial.

### Modified Capabilities

None. `friday_client` and the server are unchanged, and the Voice PE spec stays as it is.

## Impact

- **New code:**
  - `esphome/friday-respeaker.yaml`
  - `esphome/components/xvf3800/` (I2C control and the LED ring light platform)
  - `esphome/components/decimating/` (microphone platform)
  - host-compiled C++ tests for the decimator filter and the XVF3800 command framing under `esphome/test/`
- **Unchanged:** `esphome/components/friday_client/`, `esphome/friday-voice-pe.yaml`, all of `packages/` and `modules/`.
- **Docs:** `README.md` (new satellite section), `openspec/config.yaml` context (the satellite and its components).
- **Dependencies:**
  - ESPHome 2026.9 on the development machine
  - `dfu-util` for the one-time XVF3800 flash
  - Seeed's XVF3800 firmware image from `respeaker/reSpeaker_XVF3800_USB_4MIC_ARRAY` (downloaded by the user, not vendored)
  - no new IDF components
- **Tests:** the host C++ tests, `esphome config` and `esphome compile` of both YAML files, and a manual run on the board covering wake, conversation, barge-in, mute, LEDs, volume and onboarding.
- **In flight:** none.
