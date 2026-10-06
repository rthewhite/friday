# Tasks

## 1. Hardware bring-up

- [x] 1.1 With the user, flash the XVF3800 once. Steps:
  - Download `respeaker_xvf3800_i2s_master_v1.0.9_48k.bin` from `respeaker/reSpeaker_XVF3800_USB_4MIC_ARRAY` and check its md5 against the repo.
  - Put the board in safe mode: hold Mute while plugging in the XVF USB port.
  - Run `dfu-util -R -e -a 1 -D <file>`.

  Verify: `dfu-util -l` lists the device before the flash, and the flash completes without errors.

  Done 2026-10-05 by the user: the image's md5 matched (`b62766ccf8fbbaf924d0d13beace495b`), the flash completed, and the board no longer appears in DFU mode afterwards.
- [x] 1.2 Bring up the board with a throwaway YAML in the scratchpad, not committed. It checks:
  - an I2C scan answers at `0x2C` and `0x18`,
  - a lambda reads `VERSION` (48, 0) and gets 1.0.9,
  - raw I2S mic peak levels for left and right at 48 kHz, while speaking and while silent,
  - a test tone plays through the JST speaker after setting GPO 31 low, with no codec writes,
  - GPO 30 (read with 20, 0) changes when the Mute button is pressed,
  - one `LED_RING_COLOR` write lights the ring, which settles the byte order and where LED 0 sits.

  Record the results in `design.md`. Specifically: whether the codec needs host init (decision 6), whether native mute drives GPO 30 (decision 5), and the LED byte order. Update the decisions if any finding contradicts them. Verify: every check has a recorded result.

  Done 2026-10-05: results are in design.md (Context, "Bring-up results"). Everything passed except the speaker tone, which couldn't be checked because no speaker was attached; the user chose to continue and leave that check to task 6.1. Native mute drives GPO 30, so no fallback is needed. The LED byte order is 0x00RRGGBB, and LED 0 is at the top centre.

## 2. XVF3800 protocol (host)

- [x] 2.1 Read `python_control/xvf_host.py` at the 1.0.9 tag. Write `esphome/components/xvf3800/xvf3800_protocol.h` (header-only, no ESPHome includes) containing:
  - the 1.0.9 command ids used here: `VERSION`, `GPO_READ_VALUES`, `GPO_WRITE_VALUE`, `LED_EFFECT`, `LED_RING_COLOR`, AUDIO_MGR `OP_L` / `OP_R`, `AEC_ASROUTONOFF` and PP `AGCONOFF`, plus the routing category values for decision 4;
  - write and read frame builders;
  - status classification (done, retry, error);
  - version parsing.

  Add `esphome/test/xvf3800_protocol_test.cpp` and `esphome/test/run.sh`, which compiles each `*_test.cpp` with `c++ -std=c++17 -O2 -I esphome/components` and runs it. The test covers:
  - frame bytes for a write, a read and the 51-byte LED write,
  - statuses 0, 1, 0x40 and 3,
  - the version `1.0.9` parsed from its three bytes,
  - a frame over 60 bytes refused.

  Verify: `esphome/test/run.sh` passes.

  Done: ids from `xvf_host.py` at master `4b49bfd19977` (the repo has no tags; its I2S readme marks 1.0.9 current), routing categories from the XMOS user guide (6 processed, 7 AEC residual / ASR, source 3 auto-select). Reads follow Seeed's I2C example: request with a stop, then a separate read.

## 3. Decimating microphone

- [x] 3.1 Write `esphome/components/decimating/decimator.h` (header-only, no ESPHome includes) as described in design decision 3:
  - Kaiser-windowed-sinc design from tap count, cutoff and β,
  - per-channel state,
  - decimation by 3 over interleaved 32-bit samples, computing only the kept outputs.

  Add `esphome/test/decimator_test.cpp` covering:
  - passband ripple ≤ 0.5 dB at 0.1 to 7 kHz,
  - ≥ 50 dB attenuation for 8 to 24 kHz tones,
  - a 12 kHz tone not showing up at 4 kHz,
  - identical output whether the input arrives in one block or in odd-sized pieces (1, 7 and 641 frames),
  - channels kept separate.

  Verify: `esphome/test/run.sh` passes.

  Done: with 175 taps, cutoff 7.5 kHz and β 5.65, the measured passband is -0.008 to +0.006 dB, the worst stopband tone -61 dB, and a 12 kHz tone -80 dB.
- [x] 3.2 Add the ESPHome platform `microphone: - platform: decimating` in `esphome/components/decimating/` (`__init__.py`, `microphone.py`, `decimating_microphone.h/.cpp`). It:
  - wraps a source microphone given by id and requires a 48 kHz, 32-bit source;
  - declares output stream limits of 16 kHz, the source's channels and 32 bits, so `microphone_source` final validation passes;
  - reference-counts `start()` / `stop()` to the source;
  - mirrors the source's running state;
  - filters in the source's data callback.

  Verify with a minimal scratch YAML (i2s mic → decimating mic → `micro_wake_word` on channel 1 and a 16 kHz `microphone_source`): `esphome config` passes, `esphome compile` succeeds, and a config feeding a 16 kHz source into `decimating` is rejected with a clear message.

  Done: the scratch config (decimating feeding `friday_client` on channel 0 and `micro_wake_word` on channel 1) validates and compiles. A 16 kHz source is refused with "Invalid configuration for the specified microphone. The decimating component requires a 48000 sample rate." start()/stop() pass straight through to the source, which already counts its listeners; the platform keeps its own count only to know when to filter and when to reset.

## 4. XVF3800 hub and LED ring

- [x] 4.1 Add the `xvf3800` hub component (`esphome/components/xvf3800/__init__.py`, `xvf3800.h/.cpp`, an `I2CDevice`, design decisions 1, 4 and 5). It needs:
  - **Boot:** the version check with a status string and `is_ready()`.
  - **Settings:** the boot settings, with `left`, `right` and `agc` options.
  - **I/O:** reads with retry, `set_mute` / `is_muted`, the 100 ms GPO poll and the `on_mute` trigger (with the event-mode fallback only if task 1.2 found it necessary).
  - **Actions:** `xvf3800.mute` and `xvf3800.unmute`.
  - **Codec:** any codec init that task 1.2 found necessary.
  - **`dump_config`:** the version and the routing.

  Verify:
  - `esphome compile` of the scratch YAML from 3.2 with the hub added succeeds.
  - On the board, the log shows `1.0.9` and the routing.
  - A build with a wrong address shows "not responding on I2C" and `is_ready()` false.
  - Pressing Mute fires `on_mute` both ways.

  Done 2026-10-06: the scratch config (I2S mic, decimating, hub, ring) compiles. On the board, `dump_config` shows status 1.0.9, left 6/3, right 7/3 and AGC off. With address `0x2D` the hub logs "not responding at 0x2D" after the 10 s probe, sets the error flag, and `is_ready()` stays false. Both the Mute button and the `xvf3800.mute` / `xvf3800.unmute` actions fire `on_mute` both ways. No codec init and no event-mode fallback (per the bring-up).
- [x] 4.2 Add the `light: - platform: xvf3800` addressable light in `esphome/components/xvf3800/light.py`, `xvf3800_light.h/.cpp` (design decision 2): 12 LEDs, written only on change and at most every 50 ms, in the byte order task 1.2 found. Verify: it compiles, and on the board a `light.turn_on` with an `addressable_rainbow` effect shows a smooth rainbow with no I2C errors in the log for 5 minutes.

  Done 2026-10-06: it compiles. On the board the user saw a smooth rainbow. The ring was written about every 57 ms, and 5 minutes of the effect logged no warnings or errors. Note for 5.1: at 40 % brightness with the default 2.8 gamma, most rainbow channels drop to single digits and the ring looks off in daylight. At 100 % it is clearly visible, so pick the ring's default brightness with that in mind.

## 5. Satellite configuration and docs

- [ ] 5.1 Write `esphome/friday-respeaker.yaml` (design decisions 6 to 8). It contains:
  - the board, PSRAM, Wi-Fi, API (`reboot_timeout: 0s`), OTA and logger;
  - both I2S buses on shared pins, the I2S mic, the `decimating` mic, the speaker chain and software volume;
  - `friday_client` on decimated channel 0 with `friday_speaker`;
  - `micro_wake_word` with the pinned "hey friday" model on channel 1, gated by `xvf3800` ready and mute;
  - the `xvf3800` hub;
  - the ring light, its partitions and the copied effects, plus Twinkle for no Wi-Fi, all driven by `control_leds`;
  - the Mute template switch and `on_mute` mirroring into the decimating mic's mute flag and a restored global, applied at boot;
  - the volume number (0 to 100 %, step 5, default 60 %, restored);
  - text sensors for the key fingerprint and the XVF3800 status;
  - factory reset and restart buttons;
  - a header comment in the Voice PE file's style.

  Verify:
  - `esphome config esphome/friday-respeaker.yaml` and `esphome compile esphome/friday-respeaker.yaml` succeed.
  - `esphome compile esphome/friday-voice-pe.yaml` still succeeds.
  - `git diff main -- esphome/components/friday_client esphome/friday-voice-pe.yaml` is empty.
- [ ] 5.2 Document the satellite. In `README.md`, add a "reSpeaker XVF3800" section next to the Voice PE's covering:
  - the one-time XVF3800 firmware flash (download, md5, safe mode, `dfu-util`, rollback to the USB firmware),
  - which USB port powers the board and which flashes the ESP32,
  - `esphome run friday-respeaker.yaml`, onboarding, the status and fingerprint sensors,
  - mute and volume.

  In the `openspec/config.yaml` context, add the satellite, the `xvf3800` and `decimating` components, and the host tests in `esphome/test/run.sh`. Verify: the README commands match the YAML file name and the test script path, and `openspec validate xvf3800-satellite --strict` passes.

## 6. On-device verification

- [ ] 6.1 Flash `friday-respeaker.yaml` to the board and onboard it against Friday:
  - the first wake word gives a pending attempt with the fingerprint shown in Home Assistant;
  - after accepting, a wake word opens a session;
  - a question gets a spoken answer through the JST speaker;
  - Friday ending the conversation returns the device to idle;
  - a long reply plays to the end without a false interruption;
  - talking over Friday interrupts it.

  Verify: each of these is observed and noted in the task, with the `barge_in_delay` and `gain_factor` values used.
- [ ] 6.2 On the board, check mute, LEDs, volume and restarts:
  - the Mute button and the HA switch both mute (red LED on, wake word ignored) and unmute;
  - muting mid-session sends silence while playback continues;
  - the device comes back muted after an OTA restart and after a power cut;
  - the ring shows connecting, listening, speaking and pending, follows the HA ring colour, and is off when idle;
  - volume set to 40 % applies to the chime and reply and survives a restart.

  Verify: each spec scenario in `respeaker-client` is ticked off in this task's notes, and anything that didn't pass is fixed or recorded as a follow-up.
