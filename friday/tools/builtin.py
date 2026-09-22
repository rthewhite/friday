"""Starter tools. Add your own modules and import them in load_builtin()."""
from datetime import datetime
from zoneinfo import ZoneInfo

from . import tool


@tool(
    "get_current_time",
    "Get the current date and time, optionally in a specific IANA timezone.",
    {
        "type": "object",
        "properties": {
            "timezone": {"type": "string", "description": "IANA zone, e.g. Europe/Amsterdam"}
        },
    },
)
def get_current_time(timezone: str = "Europe/Amsterdam") -> dict:
    now = datetime.now(ZoneInfo(timezone))
    return {"iso": now.isoformat(), "human": now.strftime("%A %d %B %Y, %H:%M"), "timezone": timezone}


@tool(
    "set_timer",
    "Start a countdown timer. Reports back when it finishes.",
    {
        "type": "object",
        "properties": {"seconds": {"type": "integer"}, "label": {"type": "string"}},
        "required": ["seconds"],
    },
    scheduling="WHEN_IDLE",
)
async def set_timer(seconds: int, label: str = "timer") -> dict:
    import asyncio
    await asyncio.sleep(seconds)
    return {"done": True, "label": label, "message": f"{label} finished after {seconds} seconds"}
