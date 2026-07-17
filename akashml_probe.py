#!/usr/bin/env python3
"""Probe AkashML OpenAI-compatible inference API capabilities."""

from __future__ import annotations

import json
import os
import sys
from typing import Any

from openai import OpenAI

BASE_URL = "https://api.akashml.com/v1"
PRIMARY_MODEL = "Qwen/Qwen3.5-35B-A3B"
FALLBACK_MODEL = "deepseek-ai/DeepSeek-V3.2"
TRUNCATE = 1200


def truncate(text: str, n: int = TRUNCATE) -> str:
    text = text if isinstance(text, str) else str(text)
    if len(text) <= n:
        return text
    return text[:n] + f"... [{len(text) - n} more chars]"


def dump(obj: Any) -> str:
    try:
        return truncate(json.dumps(obj, indent=2, default=str))
    except Exception:
        return truncate(repr(obj))


def message_to_dict(msg: Any) -> dict[str, Any]:
    if hasattr(msg, "model_dump"):
        return msg.model_dump()
    if isinstance(msg, dict):
        return msg
    return {"repr": repr(msg)}


def visible_text(msg: dict[str, Any]) -> str:
    """Prefer content; fall back to reasoning_content (some models fill only that)."""
    content = msg.get("content")
    if isinstance(content, str) and content.strip():
        return content
    if isinstance(content, list):
        bits = []
        for part in content:
            if isinstance(part, dict) and part.get("type") == "text":
                bits.append(part.get("text") or "")
            elif isinstance(part, str):
                bits.append(part)
        joined = "\n".join(bits).strip()
        if joined:
            return joined
    reasoning = msg.get("reasoning_content")
    if isinstance(reasoning, str) and reasoning.strip():
        return reasoning
    return (content or "") if isinstance(content, str) else ""


def resolve_model(client: OpenAI) -> str:
    print(f"Trying primary model: {PRIMARY_MODEL}")
    try:
        resp = client.chat.completions.create(
            model=PRIMARY_MODEL,
            messages=[{"role": "user", "content": "Reply with exactly: ok"}],
            max_tokens=16,
        )
        print(f"Primary model OK. Sample: {truncate(dump(message_to_dict(resp.choices[0].message)), 200)}")
        return PRIMARY_MODEL
    except Exception as e:
        print(f"Primary model failed: {type(e).__name__}: {e}")
        print(f"Falling back to: {FALLBACK_MODEL}")
        return FALLBACK_MODEL


def print_result(name: str, verdict: str, behavior: str, raw: str) -> dict[str, str]:
    print("\n" + "=" * 72)
    print(f"TEST: {name}")
    print(f"RESULT: {verdict}")
    print(f"BEHAVIOR: {behavior}")
    print(f"RAW RESPONSE (truncated):\n{raw}")
    print("=" * 72)
    return {"name": name, "verdict": verdict, "behavior": behavior}


def test1_live_internet(client: OpenAI, model: str) -> dict[str, str]:
    name = "TEST 1 — Live internet / today's date + news"
    try:
        resp = client.chat.completions.create(
            model=model,
            messages=[
                {
                    "role": "user",
                    "content": (
                        "What is today's date, and what is one news headline from this week?"
                    ),
                }
            ],
            max_tokens=400,
        )
        msg = message_to_dict(resp.choices[0].message)
        content = visible_text(msg)
        raw = dump(msg)

        # Heuristic: text-only APIs refuse, hedge, or invent dates without real browsing.
        lower = content.lower()
        refuses = any(
            p in lower
            for p in (
                "don't have access",
                "do not have access",
                "can't browse",
                "cannot browse",
                "no access to the internet",
                "no real-time",
                "as of my last",
                "knowledge cutoff",
                "unable to access",
                "cannot access live",
                "don't have real-time",
                "do not have real-time",
            )
        )
        if refuses or not content.strip():
            verdict = "PASS (expected for text-only)"
            behavior = "Behaves like text-only inference (no implicit web access)"
        else:
            verdict = "PASS (responded; inspect for hallucination vs real web)"
            behavior = (
                "Returned an answer without tools — likely no implicit web, "
                "or hallucinated; inspect raw text"
            )
        return print_result(name, verdict, behavior, raw)
    except Exception as e:
        return print_result(
            name,
            "FAIL",
            f"Request error: {type(e).__name__}",
            truncate(f"{type(e).__name__}: {e}"),
        )


def test2_hosted_web_search(client: OpenAI, model: str) -> dict[str, str]:
    name = "TEST 2 — Hosted web_search tool"
    parts: list[str] = []
    outcomes: list[str] = []

    # 2a: OpenAI Responses-style tools=[{"type":"web_search"}]
    parts.append("--- 2a: client.responses + tools=[{type: web_search}] ---")
    try:
        resp = client.responses.create(
            model=model,
            input="Search the web: what is one news headline from this week?",
            tools=[{"type": "web_search"}],
        )
        raw_a = dump(resp.model_dump() if hasattr(resp, "model_dump") else resp)
        parts.append(raw_a)
        outcomes.append("responses+web_search: ACCEPTED (got response)")
    except Exception as e:
        err = f"{type(e).__name__}: {e}"
        parts.append(truncate(err))
        outcomes.append(f"responses+web_search: REJECTED/ERROR ({type(e).__name__})")

    parts.append("\n--- 2a2: chat.completions + tools=[{type: web_search}] ---")
    try:
        resp = client.chat.completions.create(
            model=model,
            messages=[
                {
                    "role": "user",
                    "content": "Search the web: what is one news headline from this week?",
                }
            ],
            tools=[{"type": "web_search"}],
            max_tokens=300,
        )
        raw_a2 = dump(message_to_dict(resp.choices[0].message))
        parts.append(raw_a2)
        outcomes.append("chat+type=web_search: ACCEPTED (got response)")
    except Exception as e:
        err = f"{type(e).__name__}: {e}"
        parts.append(truncate(err))
        outcomes.append(f"chat+type=web_search: REJECTED/ERROR ({type(e).__name__})")

    # 2b: Function-style tool named web_search
    parts.append("\n--- 2b: Function-style tool named web_search ---")
    try:
        resp = client.chat.completions.create(
            model=model,
            messages=[
                {
                    "role": "user",
                    "content": "Use web_search to find one news headline from this week.",
                }
            ],
            tools=[
                {
                    "type": "function",
                    "function": {
                        "name": "web_search",
                        "description": "Search the live web for current information.",
                        "parameters": {
                            "type": "object",
                            "properties": {
                                "query": {
                                    "type": "string",
                                    "description": "Search query",
                                }
                            },
                            "required": ["query"],
                        },
                    },
                }
            ],
            tool_choice="auto",
            max_tokens=300,
        )
        msg = message_to_dict(resp.choices[0].message)
        parts.append(dump(msg))
        tool_calls = msg.get("tool_calls") or []
        if tool_calls:
            outcomes.append("function web_search: ACCEPTED + model emitted tool_call")
        else:
            outcomes.append(
                "function web_search: ACCEPTED (no tool_call; model answered in text)"
            )
    except Exception as e:
        err = f"{type(e).__name__}: {e}"
        parts.append(truncate(err))
        outcomes.append(f"function web_search: REJECTED/ERROR ({type(e).__name__})")

    summary = " | ".join(outcomes)
    hosted = any(
        o.startswith("responses+web_search: ACCEPTED") or o.startswith("chat+type=web_search: ACCEPTED")
        for o in outcomes
    )
    if hosted:
        verdict = "PASS (hosted/style accepted — inspect raw)"
        behavior = "API accepted a web_search-shaped tool; may not execute real search"
    elif any("function web_search: ACCEPTED" in o for o in outcomes):
        verdict = "PASS (no hosted web_search; function schema accepted)"
        behavior = "Text-only API: no hosted web_search; function tool schema ok"
    else:
        verdict = "PASS (rejected hosted web_search — expected for text-only)"
        behavior = "Rejects or errors on web_search tooling"
    return print_result(name, verdict, f"{behavior}. Details: {summary}", "\n".join(parts))


def test3_function_calling(client: OpenAI, model: str) -> dict[str, str]:
    name = "TEST 3 — Function / tool calling (get_weather)"
    tools = [
        {
            "type": "function",
            "function": {
                "name": "get_weather",
                "description": "Get the current weather for a city.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "city": {
                            "type": "string",
                            "description": "City name, e.g. Berlin",
                        }
                    },
                    "required": ["city"],
                },
            },
        }
    ]
    try:
        resp = client.chat.completions.create(
            model=model,
            messages=[{"role": "user", "content": "What's the weather in Berlin?"}],
            tools=tools,
            tool_choice="auto",
            max_tokens=300,
        )
        msg = message_to_dict(resp.choices[0].message)
        raw = dump(msg)
        tool_calls = msg.get("tool_calls") or []

        # Also check finish_reason if present on choice
        finish = getattr(resp.choices[0], "finish_reason", None)

        if tool_calls:
            names = [
                (tc.get("function") or {}).get("name")
                if isinstance(tc, dict)
                else getattr(getattr(tc, "function", None), "name", None)
                for tc in tool_calls
            ]
            if any(n == "get_weather" for n in names):
                verdict = "PASS"
                behavior = (
                    "Function calling works — model returned get_weather tool_call "
                    f"(finish_reason={finish})"
                )
            else:
                verdict = "PASS (tool_call present, unexpected name)"
                behavior = f"Got tool_calls {names} (finish_reason={finish})"
        else:
            verdict = "FAIL"
            behavior = (
                "No tool_call — answered in text only; function calling may be unsupported "
                f"(finish_reason={finish})"
            )
        return print_result(name, verdict, behavior, raw)
    except Exception as e:
        return print_result(
            name,
            "FAIL",
            f"Tool calling request rejected: {type(e).__name__}",
            truncate(f"{type(e).__name__}: {e}"),
        )


def test4_image(client: OpenAI, model: str) -> dict[str, str]:
    name = "TEST 4 — Image output"
    try:
        resp = client.chat.completions.create(
            model=model,
            messages=[{"role": "user", "content": "Give me an image of a mountain."}],
            max_tokens=400,
        )
        msg = message_to_dict(resp.choices[0].message)
        raw = dump(msg)
        content = msg.get("content")
        text = visible_text(msg)
        # Detect multimodal / image payloads
        has_image = False
        if isinstance(content, list):
            for part in content:
                if isinstance(part, dict) and part.get("type") in (
                    "image_url",
                    "image",
                    "output_image",
                ):
                    has_image = True
        # Rare: images field on message
        if msg.get("images") or msg.get("image"):
            has_image = True

        if has_image:
            verdict = "FAIL (unexpected image payload)"
            behavior = "Response includes image-like content — not text-only"
        else:
            # Note fake URLs in text if present
            lower = text.lower()
            mentions_url = "http://" in lower or "https://" in lower
            verdict = "PASS (text-only, as expected)"
            behavior = (
                "Text-only inference — no real image generation/output"
                + (" (may include a fake/suggested URL in text)" if mentions_url else "")
            )
        return print_result(name, verdict, behavior, raw)
    except Exception as e:
        return print_result(
            name,
            "FAIL",
            f"Request error: {type(e).__name__}",
            truncate(f"{type(e).__name__}: {e}"),
        )


def summarize(results: list[dict[str, str]], model: str) -> None:
    # Derive yes/no/unknown for the summary table from behaviors/verdicts
    def yn(r: dict[str, str], yes_hints: tuple[str, ...], no_hints: tuple[str, ...]) -> str:
        blob = f"{r['verdict']} {r['behavior']}".lower()
        if any(h in blob for h in yes_hints):
            return "YES / likely"
        if any(h in blob for h in no_hints):
            return "NO / unlikely"
        return "UNCLEAR — see raw"

    r1, r2, r3, r4 = results
    rows = [
        (
            "web access?",
            yn(
                r1,
                ("live web", "real-time browse"),
                ("no implicit web", "text-only", "hallucin"),
            ),
        ),
        (
            "hosted web_search tool?",
            yn(
                r2,
                ("hosted/style accepted", "responses+web_search: accepted"),
                ("no hosted", "rejects", "rejected", "error"),
            ),
        ),
        (
            "function calling?",
            "YES" if r3["verdict"].startswith("PASS") and "works" in r3["behavior"].lower() else (
                "NO" if r3["verdict"].startswith("FAIL") else "PARTIAL / unclear"
            ),
        ),
        (
            "image output?",
            yn(
                r4,
                ("includes image", "not text-only"),
                ("text-only", "no real image"),
            ),
        ),
    ]

    print("\n" + "#" * 72)
    print(f"SUMMARY (model={model})")
    print("#" * 72)
    print(f"{'Capability':<28} {'Finding':<40}")
    print("-" * 68)
    for cap, finding in rows:
        print(f"{cap:<28} {finding:<40}")
    print("-" * 68)
    print("Per-test verdicts:")
    for r in results:
        print(f"  • {r['name']}: {r['verdict']}")
        print(f"    {r['behavior']}")


def main() -> int:
    api_key = os.environ.get("AKASHML_API_KEY")
    if not api_key:
        print("ERROR: Set AKASHML_API_KEY in the environment.", file=sys.stderr)
        return 1

    client = OpenAI(api_key=api_key, base_url=BASE_URL)
    print(f"AkashML probe → {BASE_URL}")
    model = resolve_model(client)
    print(f"Using model: {model}")

    results = [
        test1_live_internet(client, model),
        test2_hosted_web_search(client, model),
        test3_function_calling(client, model),
        test4_image(client, model),
    ]
    summarize(results, model)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
