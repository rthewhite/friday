# Friday

Voice assistant on **Gemini 3.8 Live** (TypeScript / Node) built as a small core that hosts modules.

```
browser portal (Vue)   ── WebSocket PCM ──┐
                                          ├─► core ── Gemini Live (PCM 16k in / 24k out)
ESP32 / Voice PE       ── WebSocket PCM ──┘    │
                                               ├─► modules/builtin   time, timers, end_conversation
                                               ├─► modules/media     Jellyfin + Apple TV
                                               ├─► MCP servers       mcp.json
                                               └─◄ remote modules    dial in over /ws/modules (e.g. remote/simracing)
```

The repo is a pnpm workspace:

| Package | Path | What |
|---|---|---|
| `@friday/sdk` | `packages/sdk` | The module contract (`defineModule`, `ModuleContext`, `ToolRegistry`) and a test host |
| `@friday/core` | `packages/core` | HTTP server, `/ws/audio`, `GeminiSession`, module host, MCP loader, serves the portal |
| `@friday/portal` | `packages/portal` | Vue 3 + Vite + Tailwind shell: Talk, Modules, and module pages |
| `@friday/portal-ui` | `packages/portal-ui` | Design tokens, base components, `defineModuleUi` |
| `@friday/module-builtin` | `modules/builtin` | `get_current_time`, `set_timer`, `end_conversation` |
| `@friday/module-media` | `modules/media` | Jellyfin library and Apple TV (Infuse) playback via Home Assistant |
| `@friday/remote-simracing` | `remote/simracing` | Remote module for the gaming PC (mock telemetry for now); not part of the image |

## Run

```sh
cp .env.example .env      # add GEMINI_API_KEY
pnpm install
pnpm dev                  # core on :8080 (tsx watch) + Vite dev server on http://localhost:5173 with hot reload
```

`pnpm dev` builds the workspace first, then runs core and the portal's Vite server side by side. Vite proxies `/api`, `/health` and `/ws` to core, so open http://localhost:5173. For a production-like run, `pnpm build && pnpm start` serves the built portal from core on :8080.

`pnpm test` builds everything and runs every package's tests. `FRIDAY_MODULES=builtin,media` narrows which in-process modules load; `GET /api/modules` shows each module's status and tools.

Browsers only allow the microphone on `localhost` or HTTPS.

### Ending a conversation

The session closes itself in two ways:

- Friday calls the `end_conversation` tool once a request is fully handled and it has no follow-up question, or when you say "goodbye", "thanks", "that's all", etc. The session closes after its final words.
- If you stay silent for `FRIDAY_IDLE_TIMEOUT_MS` (default 8000) after Friday finishes a turn, the session closes. Set to `0` to disable. The timer is paused while a tool (e.g. a timer) is still running.

Clients receive `{"type":"closed","data":"ended: ..."}` and should stop capturing but finish playing queued audio.

### Barge-in and echo

Gemini interrupts itself when it detects the user speaking. On speaker devices a little of Friday's own voice leaks back into the microphone before echo cancellation converges, which Gemini can mistake for speech. `FRIDAY_VAD_START_SENSITIVITY` (default `LOW`) and `FRIDAY_VAD_PREFIX_MS` (default 200) tune how eagerly Gemini treats sound as the user talking; raise sensitivity to `HIGH` or lower the padding if barge-in feels sluggish on headphones or the browser.

## Add a module

A module is a workspace package that depends only on `@friday/sdk` and exports a `defineModule`. Core never imports a module's internals; the module gets everything through `ctx`.

```ts
// modules/weather/src/index.ts
import { defineModule, Type } from "@friday/sdk";

export default defineModule({
  manifest: {
    id: "weather",
    label: "Weather",
    config: [{ key: "WEATHER_API_KEY", required: true }],
  },
  init(ctx) {
    ctx.defineTool<{ city: string }>({
      name: "get_weather",
      description: "Weather for a city",
      parameters: { type: Type.OBJECT, properties: { city: { type: Type.STRING } }, required: ["city"] },
      handler: async ({ city }) => ({ temp_c: 18, sky: "cloudy", key: ctx.config.require("WEATHER_API_KEY") }),
    });
  },
});
```

Then add the package to `packages/core/package.json` and to the list in `packages/core/src/modules.ts`. Test it without a server:

```ts
import { createTestHost } from "@friday/sdk/test";
const h = await createTestHost(weather, { env: { WEATHER_API_KEY: "x" } });
await h.call("get_weather", { city: "Utrecht" });   // -> { result, scheduling }
```

`scheduling` controls how Gemini surfaces the result: `INTERRUPT` (default), `WHEN_IDLE`, or `SILENT`; a handler can override it per call by returning a `scheduling` key. Returning an `endConversation: "<reason>"` key asks the session to close after the model's turn (this is how `end_conversation` works). Both keys are stripped before the result reaches Gemini. Calls run in the background so audio keeps flowing during slow tools. Modules whose `required` config is missing fail to load with a clear error while the rest of Friday starts; see `packages/sdk/README.md` for the full contract.

## Portal

The browser UI is a Vue single-page app served by core at `/` with an SPA fallback. It has a `Talk` page (the voice client), a `Modules` page (everything `/api/modules` reports, with status and tools), and one page per module that ships a UI. Design tokens and base components live in `@friday/portal-ui`.

### Add a module UI

1. In the module's `package.json`, add `"friday": { "ui": "./src/ui/index.ts" }`, an export `"./ui": "./src/ui/index.ts"`, and `vue` as an optional peer dependency. Exclude `src/ui` from the module's own `tsconfig.json`; the portal's `vue-tsc` type-checks it.
2. Export a `defineModuleUi({ id, nav: { label, icon, order }, routes })` from that file. `icon` is a `portal-ui` icon name such as `play`, `grid` or `server` (or short text). Routes are Vue Router records relative to `/m/<id>`; `""` is the index page. Use `PageLayout` with `eyebrow="Modules"`, `DataTable` and `Drawer` from `@friday/portal-ui` so the page matches the shell; see `packages/portal-ui/README.md`.
3. Set `ui: true` in the module manifest and add the module package to `packages/portal/package.json` dependencies.
4. Need a backend? Register routes in `init` with `ctx.http.route("GET", "search", handler)`; they are served at `/api/modules/<id>/search`. `createTestHost(...).request()` exercises them in tests.

The portal's build step scans the workspace for `friday.ui` declarations and generates the import list, so no shell code changes are needed. Nav items for modules that are disabled or failed are hidden, and their pages show a notice. See `modules/media/src/ui` for the first example.

## Configuration, storage and keys

Core keeps a SQLite database (`friday.db` in `FRIDAY_DATA_DIR`, a PVC in k8s) for three things:

- **Configuration values.** Every key a module declares shows up under Settings > Configuration as `set`, `pending` or `env`, split into two tabs, one table each with a row per key and chips for the modules that request it. The Configuration tab holds plain values (URLs, ids), shown in the row and stored as plain text. The Secrets tab holds keys the module declared `secret: true` (tokens, API keys); they are encrypted with `FRIDAY_MASTER_KEY` and never shown again after saving. Click a row to edit in a side panel. Stored values win over the environment; `Save and reload module` applies them without restarting Friday. Scope a value to one module or make it global. Without a master key only secrets are disabled; plain configuration keeps working.
- **Remote module keys.** Settings > Remote modules issues a key per module id (shown once, stored hashed) and can revoke it, which disconnects the module immediately. `FRIDAY_MODULE_KEYS` remains a fallback.
- **Module storage.** Modules get `ctx.storage` (`get`, `set`, `delete`, `list`), a JSON key-value namespace per module. The test host provides an in-memory one.

The Modules page has a `Reload` button per in-process module, and `POST /api/modules/<id>/reload` does the same over HTTP. See `infra/README.md` for generating the master key and what happens if it is lost.

## Remote modules

A module does not have to run inside Friday. `runRemote` from `@friday/sdk/remote` runs the same `defineModule` on another machine, dials `ws(s)://<friday>/ws/modules`, authenticates with a key, and serves its tools over MCP on that socket. While the connection is up its tools are registered as `<id>__<tool>` and listed under `/api/modules` with status `connected`; when the process stops or the network drops, they are removed. The remote reconnects with backoff (1 s to 30 s) and only gives up when Friday rejects the key.

Server side, create a key under Settings > Remote modules (or set `FRIDAY_MODULE_KEYS=<id>=<key>,...` as a fallback). Client side:

```ts
import { runRemote } from "@friday/sdk/remote";
import myModule from "./module.js";

const handle = runRemote(myModule, { url: "wss://friday.thewhite.nl/ws/modules", key: process.env.FRIDAY_MODULE_KEY! });
process.on("SIGINT", () => void handle.stop());
```

Gemini binds the tool list when a conversation starts, so **new or removed remote tools apply to the next conversation**, not the one already open. `remote/simracing` is the first remote module; see its README for running it on Windows.

## Jellyfin + Apple TV (Infuse)

Tools in `modules/media`:

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

Copy `mcp.example.json` to `mcp.json` (git-ignored) and list servers. Both stdio (`command`/`args`) and streamable HTTP (`url`/`headers`) transports work. Each MCP tool is registered as `<server>__<tool>` (owner `mcp:<server>` in `/api/modules`); use `include`/`exclude` to trim large servers and `scheduling` to control how Gemini surfaces results. Override the path with `FRIDAY_MCP_CONFIG`.

Keep the total tool count modest: Gemini reads every declaration and caps at 512.

## Transport

`WS /ws/audio` carries raw PCM both ways; see the protocol in `packages/core/src/transports/ws.ts`. The web UI and the Voice PE client speak the same protocol. Transports wrap `GeminiSession` (`packages/core/src/session.ts`), so tools and prompt behaviour are shared. A WebRTC transport can be added alongside it later.

- Clients may append `?device=<id>`; the id is logged with the session and otherwise ignored for now. Unknown query parameters are ignored.
- Binary frames may be any size; batching 100 ms (3200 bytes) per frame is fine for microcontrollers.
- The server pings every `FRIDAY_WS_PING_MS` (default 20000) and drops connections that stop answering, which also closes the Gemini session. Set to `0` to disable.

Run `pnpm test` for the transport tests.

## Deploy

Every push to `main` builds `registry.thewhite.nl/friday/friday:<sha>` on the homelab runner and rolls it out to the `friday` namespace (`.github/workflows/deploy.yml`, manifest in `deploy/k8s.yaml`). Portal at `https://friday.thewhite.nl`; the Voice PE connects to `ws://friday.thewhite.nl/ws/audio`. One-time bootstrap (namespace, secrets, registry user) is in `infra/README.md`.
