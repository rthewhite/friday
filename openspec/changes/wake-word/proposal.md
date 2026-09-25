# Proposal

## Why

The Voice PE currently needs a button press to talk to Friday, which means walking over to it. Hands-free "Hey Friday" is what makes a room device useful, and the hardware already runs on-device wake word detection in the official firmware, so no audio leaves the device until the wake word fires. Wake word was explicitly deferred from the `voice-pe-client` change; this picks it up.

## What Changes

- Add ESPHome's on-device `micro_wake_word` engine to the Voice PE config with the community-trained "hey friday" model from `JohnnyPrimus/Custom_V2_MicroWakeWords`, pinned to a commit. The model is a URL in the YAML so it can be swapped for another (for example `hey_jarvis`) without code changes.
- Detecting the wake word while idle starts a Friday session exactly as a button press does. Detection is paused while a session is active so the phrase does not restart or interrupt an ongoing conversation.
- Saying "stop" during a reply already ends the session: Gemini hears it through barge-in and the system prompt tells it to end the conversation. A local "stop" model was planned and tried, then dropped as redundant.
- Play a short chime through the speaker when the wake word is detected, before the session connects, so the user knows Friday heard them. Uses the second mixer input reserved in the previous change.
- The microphone runs continuously for wake word detection; the hardware and software mute still silence it, and the wake word cannot trigger while muted.
- Button behaviour is unchanged and remains the fallback.
- Out of scope: a local "stop" wake word (Gemini handles it), Home Assistant switch to disable the wake word, wake word sensitivity selection, training a better model, multiple wake words, wake word on the browser client.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `voice-session`: the Gemini session configures speech detection sensitivity (`FRIDAY_VAD_START_SENSITIVITY`, `FRIDAY_VAD_PREFIX_MS`) so residual echo of Friday's own voice on speaker devices is not taken as a barge-in. Found during wake word testing: long replies stuttered because Gemini transcribed its own words leaking back through the microphone before echo cancellation converged.
- `voice-pe-client`: session start gains a second trigger (wake word) with detection paused during a session and blocked while muted; a chime plays on detection. Requirements for the button, streaming, playback, close handling and state exposure are unchanged, but the state trigger gains nothing new since the chime and wake word reuse existing states.

## Impact

- **Modified**: `esphome/friday-voice-pe.yaml` (add `micro_wake_word`, models, chime audio file, wiring to `friday_client.start` / `friday_client.stop`), `esphome/components/friday_client/` if the component needs to expose a "session active" condition or trigger to pause detection, README Voice PE section (usage, LED table entry if any, troubleshooting for false triggers).
- **Modified (server)**: `src/session.ts` and `src/config.ts` gain the speech detection settings; `.env.example` and README document them.
- **Unchanged**: the `audio-transport` spec and the browser client.
- **Dependencies**: `esp-tflite-micro` and `esp-micro-speech-features` IDF components pulled in automatically by `micro_wake_word`; the community model repo on GitHub at build time.
- **Risk**: the community "hey friday" model has far less training than the official ones (its cutoff is set low at 0.66). False triggers or misses are likely at first. Mitigation is that the model is swappable in one line, and the same author publishes a free local trainer if a better model is wanted later. Flash and RAM headroom: the current firmware uses 16% flash and 40% RAM, and the upstream firmware runs three wake word models on this hardware, so one plus `stop` fits.
