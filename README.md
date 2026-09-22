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

## Transport

`WS /ws/audio` carries raw PCM both ways; see the protocol in `src/transports/ws.ts`. The web UI and a future ESP32 client speak the same protocol. Transports wrap `GeminiSession` (`src/session.ts`), so tools and prompt behaviour are shared. A WebRTC transport can be added alongside it later.
