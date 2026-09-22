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

Two tools in `src/tools/media.ts`: `list_episodes_to_watch` (Jellyfin Next Up or recently added) and `play_on_apple_tv` (wakes the Apple TV through Home Assistant and deep-links Infuse to the stream).

Setup:

1. Jellyfin: Dashboard → API Keys → create one. Set `JELLYFIN_URL`, `JELLYFIN_API_KEY`, and optionally `JELLYFIN_USER` (display name).
2. Home Assistant with the Apple TV integration set up. Create a long-lived access token (profile → Security) and set `HA_URL`, `HA_TOKEN`, and `HA_APPLE_TV_ENTITY` (the `media_player.*` entity of the Apple TV).
3. Infuse 7.6.2 or later on the Apple TV. Playback uses `infuse://x-callback-url/play?url=<jellyfin stream url>`; the Apple TV must be able to reach `JELLYFIN_URL` (override with `JELLYFIN_PUBLIC_URL`).

The stream URL embeds the Jellyfin API key, so keep this on your LAN.

## MCP servers

Copy `mcp.example.json` to `mcp.json` (git-ignored) and list servers. Both stdio (`command`/`args`) and streamable HTTP (`url`/`headers`) transports work. Each MCP tool is registered as `<server>__<tool>`; use `include`/`exclude` to trim large servers and `scheduling` to control how Gemini surfaces results. Override the path with `FRIDAY_MCP_CONFIG`.

Keep the total tool count modest: Gemini reads every declaration and caps at 512.

## Transport

`WS /ws/audio` carries raw PCM both ways; see the protocol in `src/transports/ws.ts`. The web UI and a future ESP32 client speak the same protocol. Transports wrap `GeminiSession` (`src/session.ts`), so tools and prompt behaviour are shared. A WebRTC transport can be added alongside it later.
