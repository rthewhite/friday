"""Raw WebSocket transport, intended for microcontrollers (ESP32 etc).

Protocol:
  client -> server : binary frames = 16 kHz mono s16le PCM
                     text frames   = JSON {"type":"text","text":"..."}
  server -> client : binary frames = 24 kHz mono s16le PCM
                     text frames   = JSON events (interrupted, user_text,
                                     bot_text, tool_call, tool_result,
                                     turn_complete, closed)
On "interrupted" the client must drop its playback buffer.
"""
from __future__ import annotations

import asyncio
import json
import logging

from fastapi import WebSocket, WebSocketDisconnect

from ..session import GeminiSession

log = logging.getLogger(__name__)


async def serve_ws(ws: WebSocket) -> None:
    await ws.accept()
    async with GeminiSession() as g:

        async def outbound():
            async for ev in g.events():
                if ev.kind == "audio":
                    await ws.send_bytes(ev.data)
                else:
                    await ws.send_text(json.dumps({"type": ev.kind, "data": ev.data}))
                if ev.kind == "closed":
                    break

        out = asyncio.create_task(outbound())
        try:
            while True:
                msg = await ws.receive()
                if msg.get("bytes"):
                    await g.send_audio(msg["bytes"])
                elif msg.get("text"):
                    obj = json.loads(msg["text"])
                    if obj.get("type") == "text":
                        await g.send_text(obj["text"])
                elif msg.get("type") == "websocket.disconnect":
                    break
        except WebSocketDisconnect:
            pass
        finally:
            out.cancel()
