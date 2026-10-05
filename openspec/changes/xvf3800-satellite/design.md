# Design

## Context

See proposal.md for motivation and specs/respeaker-client/spec.md for behaviour. Facts that shape the approach:

- **Hardware.**
  - The board is a reSpeaker XVF3800 with a XIAO ESP32-S3: an ESP32-S3R8 with 8 MB flash and 8 MB octal PSRAM.
  - The ESP32 and the XVF3800 share one I2S link: BCLK GPIO8, WS GPIO7, XVF→ESP data on GPIO43, ESP→XVF data on GPIO44, no MCLK.
  - They also share one I2C bus: SDA GPIO5, SCL GPIO6. The XVF3800 is at `0x2C`; the AIC3104 codec also sits on the bus at `0x18`.
  - Everything else hangs off XVF3800 GPIOs and is controlled over I2C: the Mute button (X1D09), the red mute LED with hardware mic mute (X0D30, high = muted), amplifier enable (X0D31, low = on), LED ring power (X0D33, high = on), and the 12 WS2812 LEDs.
  - No button is wired to the ESP32.
- **XVF3800 firmware.**
  - With `respeaker_xvf3800_i2s_master_v1.0.9_48k.bin` the XVF3800 is the I2S master at 48 kHz, 32-bit stereo in both directions.
  - It takes the ESP32's output as the AEC far-end reference and drives the codec itself, so anything played through the board's speaker is cancelled from the mics.
  - It processes at 16 kHz internally and upsamples its outputs to 48 kHz.
  - Runtime settings (routing, GPIO outputs, LED state) are lost when the XVF3800 resets. Some command ids differ between firmware versions; for example `LED_RING_COLOR` is 18 up to 1.0.7 and 19 from 1.0.8.
- **Control protocol.**
  - Write: `[resid, cmd, len, payload…]`.
  - Read: write `[resid, cmd | 0x80, len + 1]`, then read `len + 1` bytes `[status, payload…]` with a repeated start.
  - Status 0 means done, 1 and 0x40 mean retry, anything else is an error.
  - Transfers are at most 60 bytes.
  - Reference: `python_control/xvf_host.py` in `respeaker/reSpeaker_XVF3800_USB_4MIC_ARRAY` at the 1.0.9 tag.
- **ESPHome 2026.9.**
  - `microphone::Microphone` is a small base: `start`, `stop`, data callbacks, `audio_stream_info_`, and a mute flag that zeroes data for every callback.
  - `microphone_source` selects channels and converts bit depth, and its final validation checks the source microphone's sample rate. A wrapping microphone therefore has to declare its stream limits (16 kHz) for `friday_client` and `micro_wake_word` to validate.
  - The I2S speaker applies software volume when no `audio_dac` is configured.
  - There is no resampling microphone in 2026.9.
- **`friday_client`** needs a 16 kHz `microphone_source` (one channel, 16-bit) and a `Speaker`. It refuses `start()` when its microphone reports mute. It never touches hardware.

## Goals / Non-Goals

**Goals:**
- Keep `friday_client` and the Voice PE configuration byte-for-byte unchanged.
- Keep every hardware concern of this board in two small components and one YAML file.
- Keep pure logic (FIR design and decimation, XVF command framing and version parsing) in header-only code that compiles and is tested on the host, without ESPHome.

**Non-Goals:**
- A shared YAML package between the Voice PE and this board. The LED effects are duplicated on purpose; the two boards differ in everything below them.
- Supporting more than one XVF3800 firmware version or command-id table.
- Flashing the XVF3800 from the ESP32.

## Decisions

### 1. Own `xvf3800` component, one firmware version

`esphome/components/xvf3800/` holds an `I2CDevice` hub at `0x2C` and a `light` platform.

- **Setup (after I2C).** The hub reads `VERSION` (48, 0). If the chip doesn't answer, or reports anything other than `1.0.9`, it marks itself not ready with a reason. Otherwise it applies the boot settings:
  - output routing for I2S left and right (decision 4),
  - AGC off,
  - GPO 31 low (amp on), GPO 33 high (LED power),
  - the mute state (decision 5),
  - LED effect "ring", so the colours written by the light platform are shown.
- **Status.** It exposes `is_ready()` and a status string (`1.0.9`, `unsupported firmware 1.0.7 (needs 1.0.9)`, `not responding on I2C`). The YAML shows the string as a diagnostic `text_sensor`.
- **Mute.** It exposes `set_mute(bool)` / `is_muted()` and an `on_mute` trigger.
- **Retries.** Reads retry on status 1 or 0x40 up to 10 times, 2 ms apart, then fail.
- **Pure helpers.** Framing helpers (build write, build read, parse status, parse version) and the 1.0.9 command-id table live in `xvf3800_protocol.h`, with no ESPHome includes.

*Why own and not formatBCE's component:* see the proposal. In short:
- we need about a sixth of it,
- its firmware update ships an unpublished 1.0.7 build and would downgrade a 1.0.9 chip,
- pinning one firmware lets the command ids be constants instead of version branches.

*Why one version:* the ids differ between versions. Checking the version and refusing to run is far simpler than mapping ids per version, and the user flashes the one supported image once.

### 2. LED ring as an addressable light platform

`light: - platform: xvf3800` is an `AddressableLight` with 12 LEDs.

- `write_state` packs the 12 colours into one `LED_RING_COLOR` (20, 19) write: 12 × uint32, 48 bytes of payload, 51 bytes on the wire.
- It writes only when the buffer changed, at most every 50 ms.
- The YAML then layers two `partition` lights on it, as on the Voice PE: an internal one for state effects and a user-facing "LED Ring" whose colour and brightness the effects read.
- The Voice PE's effects are copied: Connecting, Listening, Speaking, Error, Pending, plus Twinkle for "no Wi-Fi". The Voice-PE-only Muted, Volume Display, Center Button and "Voice kit startup failed" effects are left out. The red mute LED shows mute, and when the XVF3800 is unreachable the ring can't be driven at all.

*Why a light platform:* the effects stay YAML and match the Voice PE.

*Alternative:* XVF3800 built-in effects (breath, rainbow) via `LED_EFFECT`. They're cheaper on I2C but fixed and can't follow the ring colour. Fifty-one bytes at 400 kHz every 50 ms is about 2 % of the bus.

### 3. `decimating` microphone platform, 48 → 16 kHz

`microphone: - platform: decimating` takes `microphone: <id of the I2S mic>`.

- **Start and stop.** `start()` and `stop()` forward to the source with a reference count. That matters because `friday_client` and `micro_wake_word` start and stop independently through their `microphone_source`s.
- **Filtering.** It registers one data callback on the source and filters each channel through a Kaiser-windowed-sinc low-pass FIR:
  - about 175 taps, cutoff 7.5 kHz, β for at least 60 dB, so the spec's 50 dB holds with margin,
  - it computes only every third output sample (the ones it keeps),
  - float arithmetic.
- **Output.** 16 kHz, same channel count (2), 32-bit. Its schema declares those stream limits so `microphone_source` validation works downstream.
- **State.** The filter state persists across callbacks. Coefficients are computed in `setup()` from the parameters, so no generated tables are checked in.
- **Cost.** About 16 000 × 2 × 175 ≈ 5.6 M float multiply-adds per second, a few percent of one 240 MHz core. It runs in the source microphone's task.

*Why:* `friday_client` and `micro_wake_word` both validate 16 kHz.

*Alternatives considered:*
- formatBCE's forked `i2s_audio`, which drops two of every three frames with no filter: it aliases, and it has broken on several ESPHome upgrades.
- The XVF's 16 kHz slave firmware: it needs an MCLK the ESP32 can't provide under ESPHome.
- Waiting for ESPHome's upstream `resampler` microphone (merged after 2026.9): we can switch to it in a later change, and the YAML change would be small.

*Why filter at all when the XVF3800 works at 16 kHz:* its upsampler leaves images above 8 kHz. Without a filter they would fold back into the band.

### 4. Channel routing and gain

- **I2S left → Friday.** It carries the XVF3800's processed, echo-cancelled, noise-suppressed auto-select beam, with AGC off. `friday_client` uses `channels: 0`.
- **I2S right → `micro_wake_word`.** It carries the ASR auto-select beam (fixed gain; needs `AEC_ASROUTONOFF = 1`). `micro_wake_word` uses `channels: 1`.
- **Configuration.** The component takes `left` / `right` as `[category, source]` pairs and `agc` as a boolean. The defaults are the categories above from the 1.0.9 command reference, confirmed against `xvf_host.py` in task 2.

*Why AGC off:* on the Voice PE, AGC amplified the residual echo of Friday's own voice until Gemini took it for barge-in. If the level is low without AGC, `friday_client`'s microphone source takes a `gain_factor`, which is a YAML-only tuning knob.

### 5. Mute: the XVF3800 is the source of truth

- **Button.** The firmware's native Mute-button handling toggles GPO 30, which mutes the mics in hardware and lights the red LED.
- **Polling.** The hub polls the GPO state every 100 ms. On a change it fires `on_mute`; the YAML mirrors the state into the decimating microphone's mute flag (so `friday_client` refuses `start()` and every consumer gets zeros) and into a restored global.
- **Home Assistant.** The Mute switch is a template switch that calls `set_mute` and reads `is_muted()`.
- **Boot.** The hub applies the restored state at boot, which covers the spec's "comes back muted".

*Why poll and not events:* it needs no change to the XVF's button mode, which isn't persisted anyway.

*Fallback if native handling turns out not to toggle GPO 30 on 1.0.9:* set `MUTE_FUNCTION_ENABLE` to event mode at boot, read `GPI_EVENT_PENDING_ALL` in the same poll and toggle `set_mute` ourselves. This is internal to the component; the behaviour and the YAML stay the same.

### 6. Playback and volume

- The playback chain is the Voice PE's:
  - `resampler` speaker `friday_speaker` (to 48 kHz, 16-bit),
  - `mixer` (two sources, stereo),
  - I2S speaker at 48 kHz / 32-bit stereo, secondary, on GPIO44.
- There is no `audio_dac`, so the I2S speaker applies software volume.
- Volume is a template `number` 0–100 % (step 5, default 60 %) backed by a restored global and applied with `speaker.volume_set` at boot and on change.

*Why not drive the AIC3104 volume:* the XVF3800 owns the codec, and software volume keeps the AEC reference and the speaker in step. If the bring-up (task 1) shows the codec needs host initialization to produce sound, the init goes into the hub's setup, still on `0x18` and still without an `audio_dac`.

### 7. Two I2S buses on shared clock pins

- `i2s_input` and `i2s_output` are separate `i2s_audio` buses on the same BCLK/WS pins with `allow_other_uses: true`, both `i2s_mode: secondary`.
- The microphone is on `i2s_input` (DIN GPIO43, 48 kHz, 32-bit, stereo); the speaker is on `i2s_output`.

*Why:* ESPHome's microphone and speaker each claim a bus. Two secondaries on one master's clock is the layout the community configuration runs.

### 8. YAML shape

`esphome/friday-respeaker.yaml` follows the Voice PE file's layout and comments:
- `name: friday-respeaker` (the device id),
- `board: esp32-s3-devkitc-1` with `flash_size: 8MB`, octal PSRAM at 80 MHz, the same cache and mbedTLS `sdkconfig_options`,
- `wifi`, `api` with `reboot_timeout: 0s`, `ota`, `logger`,
- `friday_client` on the decimated mic channel 0 and `friday_speaker`,
- the same pinned `micro_wake_word` model on channel 1 and `on_wake_word_detected` guarded by mute and `xvf3800` ready,
- the `xvf3800` hub, the light platforms, the mute switch, the volume number, the fingerprint and XVF3800 status text sensors, and factory reset and restart buttons.

`secrets.yaml` is shared with the Voice PE, with the same keys.

### 9. Host tests without ESPHome

`esphome/test/` holds plain C++17 tests for `decimator.h` and `xvf3800_protocol.h`, run by `esphome/test/run.sh` (`c++ -std=c++17 -O2`, no dependencies):
- frequency response: ripple up to 7 kHz, attenuation from 8 kHz, and a 12 kHz tone in;
- continuity across callback boundaries;
- frame building, status handling and version parsing.

They are not part of `pnpm -r test`: the CI runner has no C++ toolchain guarantee, and the firmware isn't built in CI either. The quality gate runs them explicitly.

## Risks / Trade-offs

- [The board ships with the USB firmware or an older I2S image] → the boot check refuses to run and the status sensor and log say why. The README documents the one-time `dfu-util` flash in safe mode (hold Mute while plugging in the XVF port) and how to verify the md5.
- [The routing categories or GPO numbers differ in 1.0.9 from the research notes] → task 2 reads them from `xvf_host.py` at the 1.0.9 tag before coding. The bring-up spike (task 1) reads raw values on the real board.
- [The codec stays silent without host initialization] → the bring-up checks speaker output first. If it is silent, the AIC3104 init goes into the hub (decision 6) and the design is updated before the YAML depends on it.
- [Native Mute handling doesn't drive GPO 30 on 1.0.9] → use the event-mode fallback in decision 5, verified during bring-up.
- [Echo cancellation is weaker than on the Voice PE and Friday interrupts itself] → `barge_in_delay`, the mic `gain_factor` and the left-channel category are YAML knobs. AEC parameter tuning (`SYS_DELAY`, `FAR_EXTGAIN`) would follow in a later change.
- [I2C traffic from the LEDs delays the mute poll or vice versa] → both run in the ESPHome loop, serialized, with tiny transfers; the ring writes only on change and at most 20 Hz.
- [Some units capture all zeros (reported for the cased version)] → the bring-up logs the raw I2S levels. If the board is affected, that is hardware or upstream, outside this change.
- [Two satellites hear the same wake word] → out of scope (proposal). Each opens its own session.

## Migration Plan

1. Flash the XVF3800 once with `respeaker_xvf3800_i2s_master_v1.0.9_48k.bin` using `dfu-util` over the XVF USB port in safe mode. Rollback: flash Seeed's USB firmware the same way.
2. Flash the ESP32 over the XIAO's USB-C with `esphome run friday-respeaker.yaml`, OTA afterwards.
3. Wake it once, compare the fingerprint, and accept it under Settings > Voice devices. No server change or deploy.

## Open Questions

- LED index 0's position on the ring, and whether the partitions need remapping so animations start at the front. This is cosmetic, settled on the board.
- Final defaults for `barge_in_delay` and the Friday mic `gain_factor`. They are YAML values and are set after listening tests.
