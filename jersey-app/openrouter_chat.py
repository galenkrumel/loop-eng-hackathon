"""OpenRouter chat helper for design decisions and multimodal critique."""

from __future__ import annotations

import base64
import json
import os
import re
from typing import Any

import httpx

OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions"
CHAT_MODEL = "openai/gpt-4.1-mini"
CRITIC_MODEL = "openai/gpt-5.5"


class OpenRouterChatError(RuntimeError):
    """Raised when the Chat Completions API fails."""


def _api_key() -> str:
    key = os.getenv("OPENROUTER_API_KEY", "").strip()
    if not key:
        raise OpenRouterChatError(
            "OPENROUTER_API_KEY is not set. Add it to jersey-app/.env"
        )
    return key


def _headers() -> dict[str, str]:
    return {
        "Authorization": f"Bearer {_api_key()}",
        "Content-Type": "application/json",
        "HTTP-Referer": "http://localhost:8765",
        "X-Title": "Jersey Design App",
    }


def _parse_json_content(content: str) -> dict[str, Any]:
    text = content.strip()
    fence = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.DOTALL)
    if fence:
        text = fence.group(1)
    else:
        # Models often wrap JSON in prose when JSON mode is off (e.g. with web search).
        start = text.find("{")
        end = text.rfind("}")
        if start != -1 and end > start:
            text = text[start : end + 1]
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError as exc:
        raise OpenRouterChatError(f"Chat did not return JSON: {text[:400]}") from exc
    if not isinstance(parsed, dict):
        raise OpenRouterChatError(f"Expected JSON object, got: {parsed}")
    return parsed


def _extract_message_content(result: dict[str, Any], status_code: int) -> str:
    if status_code >= 400:
        detail = result.get("error") if isinstance(result, dict) else result
        raise OpenRouterChatError(
            f"OpenRouter chat error {status_code}: {detail}"
        )

    choices = result.get("choices") if isinstance(result, dict) else None
    if not choices:
        raise OpenRouterChatError(f"Unexpected chat response: {result}")
    content = choices[0].get("message", {}).get("content", "")
    if not isinstance(content, str) or not content.strip():
        raise OpenRouterChatError(f"Empty chat content: {choices[0]}")
    return content


def _to_image_data_url(
    image: str | bytes,
    *,
    media_type: str = "image/png",
) -> str:
    if isinstance(image, str):
        if image.startswith("data:"):
            return image
        raise OpenRouterChatError("Image string must be a data URL")
    encoded = base64.b64encode(image).decode("ascii")
    return f"data:{media_type};base64,{encoded}"


def _with_online(model: str, enable_web_search: bool) -> str:
    if not enable_web_search:
        return model
    base = model.split(":", 1)[0]
    return f"{base}:online"


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
    async with httpx.AsyncClient(timeout=timeout) as client:
        response = await client.post(
            OPENROUTER_CHAT_URL, headers=_headers(), json=payload
        )

    try:
        result = response.json()
    except Exception as exc:
        raise OpenRouterChatError(
            f"Invalid JSON from OpenRouter chat ({response.status_code}): "
            f"{response.text[:500]}"
        ) from exc

    content = _extract_message_content(result, response.status_code)
    return _parse_json_content(content)


async def chat_json_multimodal(
    system: str,
    user_text: str,
    images: list[str | bytes],
    *,
    model: str | None = None,
    enable_web_search: bool = True,
    media_type: str = "image/png",
    timeout: float = 120.0,
) -> dict[str, Any]:
    """Ask a vision-capable model for JSON, optionally with OpenRouter web search.

    ``images`` may be raw PNG/JPEG bytes or data URLs. Text is sent before images
    (OpenRouter recommendation).

    Note: OpenAI/Azure reject JSON mode combined with web search, so when
    ``enable_web_search`` is True we omit ``response_format`` and parse JSON
    from free-form text instead.
    """
    resolved = model or os.getenv("DESIGN_CRITIC_MODEL", "").strip() or CRITIC_MODEL
    model_id = _with_online(resolved, enable_web_search)

    if images:
        parts: list[dict[str, Any]] = [{"type": "text", "text": user_text}]
        for image in images:
            parts.append(
                {
                    "type": "image_url",
                    "image_url": {
                        "url": _to_image_data_url(image, media_type=media_type),
                    },
                }
            )
        user_content: str | list[dict[str, Any]] = parts
    else:
        user_content = user_text

    payload: dict[str, Any] = {
        "model": model_id,
        "temperature": 0.2,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user_content},
        ],
    }
    # Web Search cannot be used with JSON mode (OpenAI/Azure 400).
    if enable_web_search:
        payload["plugins"] = [{"id": "web", "max_results": 5}]
    else:
        payload["response_format"] = {"type": "json_object"}

    async with httpx.AsyncClient(timeout=timeout) as client:
        response = await client.post(
            OPENROUTER_CHAT_URL, headers=_headers(), json=payload
        )

    try:
        result = response.json()
    except Exception as exc:
        raise OpenRouterChatError(
            f"Invalid JSON from OpenRouter chat ({response.status_code}): "
            f"{response.text[:500]}"
        ) from exc

    message_content = _extract_message_content(result, response.status_code)
    return _parse_json_content(message_content)


async def chat_json_web(
    system: str,
    user: str,
    *,
    model: str | None = None,
    timeout: float = 90.0,
) -> dict[str, Any]:
    """JSON chat with OpenRouter web search (no images)."""
    return await chat_json_multimodal(
        system,
        user,
        [],
        model=model or CHAT_MODEL,
        enable_web_search=True,
        timeout=timeout,
    )
