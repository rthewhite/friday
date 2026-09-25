# Friday

Voice assistant on **Gemini 3.8 Live** (TypeScript / Node) with a tool registry and pluggable transports.

```
browser (AudioWorklet) ── WebSocket PCM ──┐
                                          ├─► friday server ── Gemini Live (PCM 16k in / 24k out)
ESP32 / Voice PE       ── WebSocket PCM ──┘         │
                                                    └─► tools (src/tools/*)
```

## Run

```sh
cp .env.example .env      # add GEMINI_API_KEY
npm install
npm run dev               # http://localhost:8080
```

Browsers only allow the microphone on `localhost` or HTTPS.

### Ending a conversation

The session closes itself in two ways:

- Friday calls the `end_conversation` tool once a request is fully handled and it has no follow-up question, or when you say "goodbye", "thanks", "that's all", etc. The session closes after its final words.
- If you stay silent for `FRIDAY_IDLE_TIMEOUT_MS` (default 8000) after Friday finishes a turn, the session closes. Set to `0` to disable. The timer is paused while a tool (e.g. a timer) is still running.

Clients receive `{"type":"closed","data":"ended: ..."}` and should stop capturing but finish playing queued audio.

### Barge-in and echo

Gemini interrupts itself when it detects the user speaking. On speaker devices a little of Friday's own voice leaks back into the microphone before echo cancellation converges, which Gemini can mistake for speech. `FRIDAY_VAD_START_SENSITIVITY` (default `LOW`) and `FRIDAY_VAD_PREFIX_MS` (default 200) tune how eagerly Gemini treats sound as the user talking; raise sensitivity to `HIGH` or lower the padding if barge-in feels sluggish on headphones or the browser.

## Add a tool

Add a `defineTool()` call in `src/tools/builtin.ts` (or a new module imported from `loadTools()`):

```ts
defineTool<{ city: string }>({
  name: "get_weather",
  description: "Weather for a city",
  parameters: { type: Type.OBJECT, properties: { city: { type: Type.STRING } }, required: ["city"] },
  handler: async ({ city }) => ({ temp_c: 18, sky: "cloudy" }),
});
```

`scheduling` controls how Gemini surfaces the result: `INTERRUPT` (default), `WHEN_IDLE`, or `SILENT`. Calls run in the background so audio keeps flowing during slow tools.

## Jellyfin + Apple TV (Infuse)

Tools in `src/tools/media.ts`:

- `list_episodes_to_watch` – Jellyfin Next Up or recently added episodes.
- `search_library` – find series and movies by name, with watch state.
- `get_next_episode` – for a series, picks the episode to continue with: partially watched → next unwatched → episode 1.
- `play_on_apple_tv` – wakes the Apple TV through Home Assistant, deep-links Infuse to the stream, and marks the item played in Jellyfin (Infuse does not report progress for URL streams).

"Let's continue Band of Brothers" chains search → next episode → play.

Setup:

1. Jellyfin: Dashboard → API Keys → create one. Set `JELLYFIN_URL`, `JELLYFIN_API_KEY`, and optionally `JELLYFIN_USER` (display name).
2. Home Assistant with the Apple TV integration set up. Create a long-lived access token (profile → Security) and set `HA_URL`, `HA_TOKEN`, and `HA_APPLE_TV_ENTITY` (the `media_player.*` entity of the Apple TV).
3. Infuse 7.6.2 or later on the Apple TV. Playback uses `infuse://x-callback-url/play?url=<jellyfin stream url>`; the Apple TV must be able to reach `JELLYFIN_URL` (override with `JELLYFIN_PUBLIC_URL`).

The stream URL embeds the Jellyfin API key, so keep this on your LAN.

## Voice Preview Edition (ESP32)

`esphome/friday-voice-pe.yaml` turns a Home Assistant Voice Preview Edition into a press-to-talk Friday client. It is a thin fork of the official firmware: XMOS echo cancellation, I2S audio, DAC, LEDs, button, dial and mute switch stay as upstream; the Home Assistant voice pipeline, wake word and media player are removed and replaced by the `friday_client` component in `esphome/components/`, which speaks the `/ws/audio` protocol directly.

Prerequisites: ESPHome 2026.9 or newer on your machine (`brew install esphome` or `pip install esphome`), the Voice PE on the same LAN as the Friday server, and a USB-C cable for the first flash.

```sh
cd esphome
cp secrets.yaml.example secrets.yaml      # Wi-Fi, API key (openssl rand -base64 32), OTA password
$EDITOR friday-voice-pe.yaml              # set friday_host (and friday_port) under substitutions
esphome run friday-voice-pe.yaml          # first time over USB; afterwards it offers OTA
esphome logs friday-voice-pe.yaml         # tail the device log
```

Usage: say **"hey friday"** (or press the top button) to start talking. A short chime confirms the wake word was heard. Friday ends the session itself after handling a request or when you say goodbye; the LEDs go off once its last words have played. While Friday is talking you can talk over it, or say "stop" and Friday ends the session; the button also stops it. The dial sets the speaker volume.

Wake word detection runs on the device with ESPHome's `micro_wake_word`; the microphone is always on for that purpose, but no audio leaves the device until the wake word fires. The "hey friday" model is a community model from [Custom_V2_MicroWakeWords](https://github.com/JohnnyPrimus/Custom_V2_MicroWakeWords) (Apache-2.0), pinned to a commit in the YAML. To use another phrase, change the `model:` line under `micro_wake_word` to an official name such as `hey_jarvis` or `okay_nabu`, or to another model URL, and reflash.

| LED ring | Meaning |
|---|---|
| Off (or your LED Ring colour) | Idle |
| Warm white twinkle | No Wi-Fi |
| Slow spin | Connecting to Friday |
| Fast spin | Listening |
| Reverse spin | Friday is speaking |
| Red pulse | Error (server unreachable, connection lost, or pressed while muted); clears after 2 s |
| Two red dots | Microphone muted |
| Red every third LED | XMOS voice kit failed to start |

Troubleshooting:

- **Red pulse right after pressing**: the device cannot reach `ws://<friday_host>:<port>/ws/audio`. Check `friday_host`, that the server is running, and that nothing blocks port 8080. The server log prints `[friday-voice] session open` on success.
- **Red pulse while muted**: the side switch is on, or Mute is on in Home Assistant.
- **Choppy or late speech**: raise `buffer_duration` on the `friday_speaker` resampler (default 2000ms) at the cost of a little more delay before Friday starts talking.
- **Friday reacts to its own voice**: all playback must go through `friday_speaker`; anything bypassing the mixer defeats the XMOS echo cancellation.
- **Wake word misses or false triggers**: adjust `probability_cutoff` for `hey_friday` under `micro_wake_word` (lower is more sensitive), or try `channels: 0` for the engine's microphone. If the community model is not good enough, switch to `hey_jarvis`.
- **Friday interrupts itself during long replies**: it is hearing its own echo. Keep the client on microphone `channels: 1` (no automatic gain control) and leave `barge_in_delay` at 1500ms or raise it; on the server, `FRIDAY_VAD_START_SENSITIVITY=LOW` and `FRIDAY_VAD_PREFIX_MS=200` are the defaults. Set `FRIDAY_LOG_TRANSCRIPTS=1` to see what Gemini hears.
- **Session drops after Wi-Fi hiccups**: expected for now. The device shows the error pattern and returns to idle; the server cleans up via its ping timeout.

The component accepts `connect_timeout`, `drain_timeout`, `error_hold`, `send_chunk` (20ms to 1s, default 100ms) and `barge_in_delay` (default 1500ms) if you want to tune it. The device stays a normal ESPHome device in Home Assistant for OTA, logs, the Mute switch and the LED Ring light.

## MCP servers

Copy `mcp.example.json` to `mcp.json` (git-ignored) and list servers. Both stdio (`command`/`args`) and streamable HTTP (`url`/`headers`) transports work. Each MCP tool is registered as `<server>__<tool>`; use `include`/`exclude` to trim large servers and `scheduling` to control how Gemini surfaces results. Override the path with `FRIDAY_MCP_CONFIG`.

Keep the total tool count modest: Gemini reads every declaration and caps at 512.

## Transport

`WS /ws/audio` carries raw PCM both ways; see the protocol in `src/transports/ws.ts`. The web UI and the Voice PE client speak the same protocol. Transports wrap `GeminiSession` (`src/session.ts`), so tools and prompt behaviour are shared. A WebRTC transport can be added alongside it later.

- Clients may append `?device=<id>`; the id is logged with the session and otherwise ignored for now. Unknown query parameters are ignored.
- Binary frames may be any size; batching 100 ms (3200 bytes) per frame is fine for microcontrollers.
- The server pings every `FRIDAY_WS_PING_MS` (default 20000) and drops connections that stop answering, which also closes the Gemini session. Set to `0` to disable.

Run `npm test` for the transport tests.
