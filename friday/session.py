"""Transport-agnostic Gemini Live session.

A transport pushes 16 kHz mono s16le PCM in via `send_audio()` and consumes
`Event`s from `events()`. Tool calls are dispatched to the registry in the
background so audio keeps streaming (Gemini 3.8 Live calls are NON_BLOCKING
by default).
"""
from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from typing import AsyncIterator, Literal

from google import genai
from google.genai import types

from .config import settings
from .tools import registry

log = logging.getLogger(__name__)


@dataclass
class Event:
    kind: Literal["audio", "interrupted", "turn_complete", "user_text", "bot_text", "tool_call", "tool_result", "closed"]
    data: bytes | str | dict | None = None


class GeminiSession:
    def __init__(self) -> None:
        self._client = genai.Client(api_key=settings.api_key)
        self._events: asyncio.Queue[Event] = asyncio.Queue()
        self._session = None
        self._tasks: set[asyncio.Task] = set()
        self._closed = asyncio.Event()

    def _config(self) -> dict:
        return {
            "response_modalities": ["AUDIO"],
            "system_instruction": settings.system_prompt,
            "input_audio_transcription": {},
            "output_audio_transcription": {},
            "speech_config": {
                "voice_config": {"prebuilt_voice_config": {"voice_name": settings.voice}}
            },
            "tools": [{"function_declarations": registry.declarations()}],
        }

    async def __aenter__(self) -> "GeminiSession":
        self._cm = self._client.aio.live.connect(model=settings.model, config=self._config())
        self._session = await self._cm.__aenter__()
        self._spawn(self._receive_loop())
        log.info("gemini session open (%s, %d tools)", settings.model, len(registry.declarations()))
        return self

    async def __aexit__(self, *exc) -> None:
        await self.close()

    def _spawn(self, coro) -> None:
        t = asyncio.create_task(coro)
        self._tasks.add(t)
        t.add_done_callback(self._tasks.discard)

    # ---- inbound ---------------------------------------------------------
    async def send_audio(self, pcm16k: bytes) -> None:
        if self._session and not self._closed.is_set():
            await self._session.send_realtime_input(
                audio=types.Blob(data=pcm16k, mime_type=f"audio/pcm;rate={settings.input_rate}")
            )

    async def send_text(self, text: str) -> None:
        if self._session:
            await self._session.send_client_content(turns={"role": "user", "parts": [{"text": text}]})

    # ---- outbound --------------------------------------------------------
    async def events(self) -> AsyncIterator[Event]:
        while True:
            ev = await self._events.get()
            yield ev
            if ev.kind == "closed":
                return

    async def _receive_loop(self) -> None:
        try:
            async for msg in self._session.receive():
                if msg.tool_call:
                    for fc in msg.tool_call.function_calls:
                        self._spawn(self._run_tool(fc))
                sc = msg.server_content
                if not sc:
                    continue
                if sc.interrupted:
                    await self._events.put(Event("interrupted"))
                if sc.input_transcription and sc.input_transcription.text:
                    await self._events.put(Event("user_text", sc.input_transcription.text))
                if sc.output_transcription and sc.output_transcription.text:
                    await self._events.put(Event("bot_text", sc.output_transcription.text))
                if sc.model_turn:
                    for part in sc.model_turn.parts:
                        if part.inline_data and part.inline_data.data:
                            await self._events.put(Event("audio", part.inline_data.data))
                if sc.turn_complete:
                    await self._events.put(Event("turn_complete"))
        except Exception:  # noqa: BLE001
            log.exception("receive loop ended")
        finally:
            await self._events.put(Event("closed"))

    async def _run_tool(self, fc) -> None:
        args = dict(fc.args or {})
        await self._events.put(Event("tool_call", {"name": fc.name, "args": args}))
        result, scheduling = await registry.call(fc.name, args)
        await self._events.put(Event("tool_result", {"name": fc.name, "result": result}))
        payload = {**result, "scheduling": scheduling}
        try:
            await self._session.send_tool_response(
                function_responses=[types.FunctionResponse(id=fc.id, name=fc.name, response=payload)]
            )
        except Exception:  # noqa: BLE001
            log.exception("failed to send tool response for %s", fc.name)

    async def close(self) -> None:
        if self._closed.is_set():
            return
        self._closed.set()
        for t in list(self._tasks):
            t.cancel()
        try:
            await self._cm.__aexit__(None, None, None)
        except Exception:  # noqa: BLE001
            pass
