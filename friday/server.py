from __future__ import annotations

import logging
from pathlib import Path

import uvicorn
from fastapi import FastAPI, WebSocket
from fastapi.responses import FileResponse
from pydantic import BaseModel

from .config import settings
from .tools import load_builtin, registry
from .transports.webrtc import WebRTCPeer
from .transports.ws import serve_ws

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("friday")

WEB = Path(__file__).resolve().parent.parent / "web"

app = FastAPI(title="Friday")
peers: set[WebRTCPeer] = set()


class Offer(BaseModel):
    sdp: str
    type: str


@app.on_event("startup")
async def _startup():
    load_builtin()
    if not settings.api_key:
        log.warning("GEMINI_API_KEY is not set")
    log.info("tools: %s", [t["name"] for t in registry.declarations()])


@app.on_event("shutdown")
async def _shutdown():
    for p in list(peers):
        await p.close()


@app.get("/")
async def index():
    return FileResponse(WEB / "index.html")


@app.get("/api/tools")
async def tools():
    return registry.declarations()


@app.post("/api/webrtc/offer")
async def offer(o: Offer):
    peer = WebRTCPeer()
    peers.add(peer)

    @peer.pc.on("connectionstatechange")
    async def _cleanup():
        if peer.pc.connectionState in ("failed", "closed"):
            peers.discard(peer)

    return await peer.handle_offer(o.sdp, o.type)


@app.websocket("/ws/audio")
async def ws_audio(ws: WebSocket):
    await serve_ws(ws)


def main() -> None:
    uvicorn.run("friday.server:app", host=settings.host, port=settings.port, reload=False)


if __name__ == "__main__":
    main()
