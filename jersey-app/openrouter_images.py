"""Thin OpenRouter Images API client for openai/gpt-image-2."""

from __future__ import annotations

import base64
import os
from typing import Any

import httpx

OPENROUTER_IMAGES_URL = "https://openrouter.ai/api/v1/images"
MODEL = "openai/gpt-image-2"


class OpenRouterImageError(RuntimeError):
    """Raised when the Images API returns an error or unexpected payload."""


def _api_key() -> str:
    key = os.getenv("OPENROUTER_API_KEY", "").strip()
    if not key:
        raise OpenRouterImageError(
            "OPENROUTER_API_KEY is not set. Add it to jersey-app/.env"
        )
    return key


def to_data_url(image_bytes: bytes, media_type: str = "image/png") -> str:
    encoded = base64.b64encode(image_bytes).decode("ascii")
    return f"data:{media_type};base64,{encoded}"


def reference_from_bytes(
    image_bytes: bytes, media_type: str = "image/png"
) -> dict[str, Any]:
    return {
        "type": "image_url",
        "image_url": {"url": to_data_url(image_bytes, media_type)},
    }


async def generate_image(
    prompt: str,
    *,
    references: list[dict[str, Any]] | None = None,
    quality: str = "medium",
    output_format: str = "png",
    aspect_ratio: str = "1:1",
    timeout: float = 300.0,
) -> bytes:
    """Generate an image; optionally guide with input_references. Returns PNG bytes."""
    payload: dict[str, Any] = {
        "model": MODEL,
        "prompt": prompt,
        "quality": quality,
        "output_format": output_format,
        "aspect_ratio": aspect_ratio,
        "n": 1,
    }
    if references:
        payload["input_references"] = references

    headers = {
        "Authorization": f"Bearer {_api_key()}",
        "Content-Type": "application/json",
        "HTTP-Referer": "http://localhost:8000",
        "X-Title": "Jersey Design App",
    }

    async with httpx.AsyncClient(timeout=timeout) as client:
        response = await client.post(
            OPENROUTER_IMAGES_URL, headers=headers, json=payload
        )

    try:
        result = response.json()
    except Exception as exc:
        raise OpenRouterImageError(
            f"Invalid JSON from OpenRouter ({response.status_code}): {response.text[:500]}"
        ) from exc

    if response.status_code >= 400:
        detail = result.get("error") if isinstance(result, dict) else result
        raise OpenRouterImageError(
            f"OpenRouter error {response.status_code}: {detail}"
        )

    data = result.get("data") if isinstance(result, dict) else None
    if not data or not isinstance(data, list):
        raise OpenRouterImageError(f"Unexpected response shape: {result}")

    first = data[0]
    b64 = first.get("b64_json") if isinstance(first, dict) else None
    if not b64:
        raise OpenRouterImageError(f"No b64_json in response: {first}")

    return base64.b64decode(b64)
