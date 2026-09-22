import os
from dataclasses import dataclass

from dotenv import load_dotenv

load_dotenv()

SYSTEM_PROMPT = """You are Friday, a concise and friendly voice assistant.
Keep spoken answers short. Use tools whenever they can answer the question
instead of guessing. Answer in the language the user speaks."""


@dataclass(frozen=True)
class Settings:
    api_key: str = os.environ.get("GEMINI_API_KEY", "")
    model: str = os.environ.get("FRIDAY_MODEL", "gemini-3.8-live")
    host: str = os.environ.get("FRIDAY_HOST", "0.0.0.0")
    port: int = int(os.environ.get("FRIDAY_PORT", "8080"))
    system_prompt: str = SYSTEM_PROMPT
    voice: str = os.environ.get("FRIDAY_VOICE", "Aoede")

    # Audio formats mandated by the Live API
    input_rate: int = 16000
    output_rate: int = 24000


settings = Settings()
