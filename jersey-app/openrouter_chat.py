"""OpenRouter chat helper for design decisions (e.g. shirt color)."""

from __future__ import annotations

import json
import os
import re
from typing import Any

import httpx

OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions"
CHAT_MODEL = "openai/gpt-4.1-mini"


class OpenRouterChatError(RuntimeError):
    """Raised when the Chat Completions API fails."""


def _api_key() -> str:
    key = os.getenv("OPENROUTER_API_KEY", "").strip()
    if not key:
        raise OpenRouterChatError(
            "OPENROUTER_API_KEY is not set. Add it to jersey-app/.env"
        )
    return key


async def chat_json(
    system: str,
    user: str,
    *,
    model: str = CHAT_MODEL,
    timeout: float = 60.0,
) -> dict[str, Any]:
    """Ask the chat model for a JSON object response."""
    payload = {
        "model": model,
        "temperature": 0.3,
        "response_format": {"type": "json_object"},
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
    }
    headers = {
        "Authorization": f"Bearer {_api_key()}",
        "Content-Type": "application/json",
        "HTTP-Referer": "http://localhost:8765",
        "X-Title": "Jersey Design App",
    }
    async with httpx.AsyncClient(timeout=timeout) as client:
        response = await client.post(
            OPENROUTER_CHAT_URL, headers=headers, json=payload
        )

    try:
        result = response.json()
    except Exception as exc:
        raise OpenRouterChatError(
            f"Invalid JSON from OpenRouter chat ({response.status_code}): "
            f"{response.text[:500]}"
        ) from exc

    if response.status_code >= 400:
        detail = result.get("error") if isinstance(result, dict) else result
        raise OpenRouterChatError(
            f"OpenRouter chat error {response.status_code}: {detail}"
        )

    choices = result.get("choices") if isinstance(result, dict) else None
    if not choices:
        raise OpenRouterChatError(f"Unexpected chat response: {result}")
    content = choices[0].get("message", {}).get("content", "")
    if not isinstance(content, str) or not content.strip():
        raise OpenRouterChatError(f"Empty chat content: {choices[0]}")

    text = content.strip()
    # Tolerate fenced JSON if the model ignores response_format.
    fence = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.DOTALL)
    if fence:
        text = fence.group(1)
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError as exc:
        raise OpenRouterChatError(f"Chat did not return JSON: {text[:400]}") from exc
    if not isinstance(parsed, dict):
        raise OpenRouterChatError(f"Expected JSON object, got: {parsed}")
    return parsed
