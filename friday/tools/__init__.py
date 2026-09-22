"""Tool registry.

Register a tool with the @tool decorator. Declarations are handed to Gemini
on session start; calls are dispatched by name. Handlers may be sync or async.

    @tool(
        "get_weather",
        "Current weather for a city",
        {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]},
    )
    async def get_weather(city: str) -> dict:
        ...
"""
from __future__ import annotations

import asyncio
import inspect
import logging
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable

log = logging.getLogger(__name__)

Handler = Callable[..., Any | Awaitable[Any]]


@dataclass
class Tool:
    name: str
    description: str
    parameters: dict | None
    handler: Handler
    # How Gemini should surface the result: INTERRUPT, WHEN_IDLE or SILENT.
    scheduling: str = "INTERRUPT"

    def declaration(self) -> dict:
        d: dict[str, Any] = {"name": self.name, "description": self.description}
        if self.parameters:
            d["parameters"] = self.parameters
        return d


@dataclass
class ToolRegistry:
    _tools: dict[str, Tool] = field(default_factory=dict)

    def register(self, t: Tool) -> None:
        if t.name in self._tools:
            raise ValueError(f"duplicate tool {t.name}")
        self._tools[t.name] = t

    def declarations(self) -> list[dict]:
        return [t.declaration() for t in self._tools.values()]

    def get(self, name: str) -> Tool | None:
        return self._tools.get(name)

    async def call(self, name: str, args: dict | None) -> tuple[dict, str]:
        """Run a tool. Returns (response_payload, scheduling)."""
        t = self.get(name)
        if t is None:
            return {"error": f"unknown tool {name}"}, "INTERRUPT"
        try:
            result = t.handler(**(args or {}))
            if inspect.isawaitable(result):
                result = await result
            if not isinstance(result, dict):
                result = {"result": result}
            return result, t.scheduling
        except Exception as e:  # noqa: BLE001
            log.exception("tool %s failed", name)
            return {"error": str(e)}, "INTERRUPT"


registry = ToolRegistry()


def tool(name: str, description: str, parameters: dict | None = None, scheduling: str = "INTERRUPT"):
    def deco(fn: Handler) -> Handler:
        registry.register(Tool(name, description, parameters, fn, scheduling))
        return fn
    return deco


def load_builtin() -> None:
    from . import builtin  # noqa: F401  (registers on import)


async def run_blocking(fn: Callable[..., Any], *a: Any) -> Any:
    return await asyncio.get_running_loop().run_in_executor(None, fn, *a)
