# Friday

Voice assistant on **Gemini 3.8 Live** with a tool registry and pluggable transports.

```
browser ── WebRTC (Opus) ──┐
                           ├─► friday server ── Gemini Live (PCM 16k in / 24k out)
ESP32   ── WebSocket PCM ──┘         │
                                     └─► tools (friday/tools/*)
```

## Run

```sh
cp .env.example .env      # add GEMINI_API_KEY
uv sync
uv run friday             # http://localhost:8080
```

Browsers only allow the microphone on `localhost` or HTTPS, so put it behind a TLS proxy if you access it from another machine.

## Add a tool

Drop a function in `friday/tools/builtin.py` (or a new module imported from `load_builtin()`):

```python
@tool("get_weather", "Weather for a city",
      {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]})
async def get_weather(city: str) -> dict:
    return {"temp_c": 18, "sky": "cloudy"}
```

Return a dict. `scheduling=` controls how Gemini surfaces the result: `INTERRUPT` (default), `WHEN_IDLE`, or `SILENT`. Calls run in the background, so audio keeps flowing during slow tools.

## Transports

- `POST /api/webrtc/offer` – WebRTC for the web UI (`web/index.html`). Data channel `events` carries transcripts and tool activity.
- `WS /ws/audio` – raw PCM over WebSocket for microcontrollers. See the docstring in `friday/transports/ws.py` for the protocol. This is the path for an ESP32 / Home Assistant Voice PE style device.

Both transports wrap the same `GeminiSession` (`friday/session.py`), so tools and prompt behaviour are shared.
