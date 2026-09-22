"""Browser transport: WebRTC via aiortc.

Inbound Opus -> PCM 16 kHz mono -> Gemini.  Gemini PCM 24 kHz -> outbound
track (aiortc encodes to Opus).  A data channel named "events" carries JSON
transcripts / tool activity to the UI.
"""
from __future__ import annotations

import asyncio
import fractions
import json
import logging
import time

import av
from aiortc import MediaStreamTrack, RTCPeerConnection, RTCSessionDescription
from aiortc.mediastreams import MediaStreamError

from ..config import settings
from ..session import GeminiSession

log = logging.getLogger(__name__)

FRAME_MS = 20


class GeminiOutTrack(MediaStreamTrack):
    """Plays a byte queue of 24 kHz mono s16le PCM at real-time pace."""

    kind = "audio"

    def __init__(self) -> None:
        super().__init__()
        self.rate = settings.output_rate
        self.samples = self.rate * FRAME_MS // 1000
        self.frame_bytes = self.samples * 2
        self._buf = bytearray()
        self._lock = asyncio.Lock()
        self._pts = 0
        self._start: float | None = None

    async def push(self, pcm: bytes) -> None:
        async with self._lock:
            self._buf.extend(pcm)

    async def flush(self) -> None:
        async with self._lock:
            self._buf.clear()

    async def recv(self) -> av.AudioFrame:
        if self.readyState != "live":
            raise MediaStreamError
        if self._start is None:
            self._start = time.monotonic()
        # pace to wall clock
        due = self._start + self._pts / self.rate
        wait = due - time.monotonic()
        if wait > 0:
            await asyncio.sleep(wait)

        async with self._lock:
            chunk = bytes(self._buf[: self.frame_bytes])
            del self._buf[: self.frame_bytes]
        if len(chunk) < self.frame_bytes:
            chunk = chunk + b"\x00" * (self.frame_bytes - len(chunk))

        frame = av.AudioFrame(format="s16", layout="mono", samples=self.samples)
        frame.planes[0].update(chunk)
        frame.sample_rate = self.rate
        frame.pts = self._pts
        frame.time_base = fractions.Fraction(1, self.rate)
        self._pts += self.samples
        return frame


class WebRTCPeer:
    def __init__(self) -> None:
        self.pc = RTCPeerConnection()
        self.out = GeminiOutTrack()
        self.pc.addTrack(self.out)
        self.channel = None
        self.gemini: GeminiSession | None = None
        self._tasks: set[asyncio.Task] = set()
        self._resampler = av.AudioResampler(format="s16", layout="mono", rate=settings.input_rate)

        @self.pc.on("track")
        async def on_track(track):
            if track.kind == "audio":
                self._spawn(self._pump_in(track))

        @self.pc.on("datachannel")
        def on_datachannel(ch):
            self.channel = ch

        @self.pc.on("connectionstatechange")
        async def on_state():
            log.info("pc state %s", self.pc.connectionState)
            if self.pc.connectionState in ("failed", "closed", "disconnected"):
                await self.close()

    def _spawn(self, coro) -> None:
        t = asyncio.create_task(coro)
        self._tasks.add(t)
        t.add_done_callback(self._tasks.discard)

    async def handle_offer(self, sdp: str, typ: str) -> dict:
        self.gemini = await GeminiSession().__aenter__()
        self._spawn(self._pump_out())
        await self.pc.setRemoteDescription(RTCSessionDescription(sdp=sdp, type=typ))
        answer = await self.pc.createAnswer()
        await self.pc.setLocalDescription(answer)
        return {"sdp": self.pc.localDescription.sdp, "type": self.pc.localDescription.type}

    async def _pump_in(self, track) -> None:
        try:
            while True:
                frame = await track.recv()
                for f in self._resampler.resample(frame):
                    await self.gemini.send_audio(bytes(f.planes[0])[: f.samples * 2])
        except MediaStreamError:
            pass
        except Exception:  # noqa: BLE001
            log.exception("inbound pump died")

    async def _pump_out(self) -> None:
        async for ev in self.gemini.events():
            if ev.kind == "audio":
                await self.out.push(ev.data)
            elif ev.kind == "interrupted":
                await self.out.flush()
                self._emit({"type": "interrupted"})
            elif ev.kind == "closed":
                self._emit({"type": "closed"})
                break
            else:
                self._emit({"type": ev.kind, "data": ev.data})

    def _emit(self, obj: dict) -> None:
        if self.channel and self.channel.readyState == "open":
            self.channel.send(json.dumps(obj))

    async def close(self) -> None:
        for t in list(self._tasks):
            t.cancel()
        if self.gemini:
            await self.gemini.close()
        await self.pc.close()
