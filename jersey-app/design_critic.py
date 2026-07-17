"""Multimodal design critic: approve or request redo via OpenRouter vision + web search."""

from __future__ import annotations

import logging
import os
from dataclasses import asdict, dataclass, field
from typing import Any

from brand_lookup import BrandProfile, brand_prompt_guidance, chromatic_hexes
from openrouter_chat import OpenRouterChatError, chat_json_multimodal

log = logging.getLogger("jersey.critic")

DEFAULT_MAX_ATTEMPTS = 3


@dataclass
class DesignReview:
    """Structured critic output for one review pass."""

    decision: str  # "approve" | "redo"
    score: float
    brand_alignment: str
    prompt_alignment: str
    issues: list[str] = field(default_factory=list)
    redo_instructions: str = ""
    attempt: int = 1

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def critic_enabled() -> bool:
    """Design critic is on unless DESIGN_CRITIC_DISABLED is truthy."""
    return os.getenv("DESIGN_CRITIC_DISABLED", "").strip().lower() not in {
        "1",
        "true",
        "yes",
        "on",
    }


def max_review_attempts() -> int:
    if not critic_enabled():
        return 1
    raw = os.getenv("DESIGN_REVIEW_MAX_ATTEMPTS", "").strip()
    if not raw:
        return DEFAULT_MAX_ATTEMPTS
    try:
        return max(1, min(int(raw), 5))
    except ValueError:
        return DEFAULT_MAX_ATTEMPTS


def _brand_summary(brand: BrandProfile | None, *, has_logo_ref: bool) -> str:
    if not brand:
        return "No structured brand kit available — rely on web search for visual identity."
    bits = [
        f"Brand title: {brand.title or '(unknown)'}",
        f"Domain: {brand.domain or '(unknown)'}",
        f"Source: {brand.source or '(unknown)'}",
    ]
    if brand.slogan:
        bits.append(f'Slogan: "{brand.slogan}"')
    if brand.color_hexes:
        accents = chromatic_hexes(brand.color_hexes)
        if accents:
            bits.append(
                f"HARD COLOR LOCK — chromatic brand hexes (required, exact): "
                f"{', '.join(accents)}. Flag gold/brass/cream/off-palette inks as issues."
            )
        bits.append(f"Known colors: {', '.join(brand.color_hexes)}")
    bits.append(f"Logo reference available to generator: {'yes' if has_logo_ref else 'no'}")
    bits.append(brand_prompt_guidance(brand, has_logo_ref=has_logo_ref))
    return "\n".join(bits)


def _normalize_review(data: dict[str, Any], *, attempt: int) -> DesignReview:
    decision_raw = str(data.get("decision") or "").strip().lower()
    if decision_raw in {"approve", "approved", "pass", "ok", "yes"}:
        decision = "approve"
    else:
        decision = "redo"

    try:
        score = float(data.get("score", 0))
    except (TypeError, ValueError):
        score = 0.0
    score = max(0.0, min(10.0, score))

    issues_raw = data.get("issues") or []
    if isinstance(issues_raw, str):
        issues = [issues_raw] if issues_raw.strip() else []
    elif isinstance(issues_raw, list):
        issues = [str(i).strip() for i in issues_raw if str(i).strip()]
    else:
        issues = []

    redo = str(data.get("redo_instructions") or "").strip()
    if decision == "approve":
        redo = ""
    elif not redo and issues:
        redo = "Fix: " + "; ".join(issues)

    # Soft gate: very high score with redo → approve if no hard issues listed.
    if decision == "redo" and score >= 8.5 and not issues:
        decision = "approve"
        redo = ""

    return DesignReview(
        decision=decision,
        score=score,
        brand_alignment=str(data.get("brand_alignment") or "").strip(),
        prompt_alignment=str(data.get("prompt_alignment") or "").strip(),
        issues=issues,
        redo_instructions=redo,
        attempt=attempt,
    )


async def review_design(
    *,
    company_name: str,
    candidate_name: str,
    product_type: str,
    blank_color: str | None,
    design_prompt: str,
    brand: BrandProfile | None,
    has_logo_ref: bool,
    front_png: bytes,
    mockup_png: bytes,
    generation_brief: str,
    logo_png: bytes | None = None,
    attempt: int = 1,
) -> DesignReview:
    """Judge mockup + front print against user brief and real company brand (via web search)."""
    if not critic_enabled():
        log.info("design critic disabled — auto-approving attempt=%s", attempt)
        return DesignReview(
            decision="approve",
            score=10.0,
            brand_alignment="Design critic disabled.",
            prompt_alignment="Design critic disabled.",
            issues=[],
            redo_instructions="",
            attempt=attempt,
        )

    brief = (design_prompt or "").strip() or (
        "No free-form brief — match the company's real brand identity and produce "
        "clean athletic merch suitable for the product type."
    )
    color_line = blank_color or "white ceramic (mug)"

    system = (
        "You are a strict brand and merch design QA critic with vision. "
        "You MUST search the web for the company's real visual identity (logo style, "
        "colors, typography, existing merch/branding) before judging. "
        "Compare the provided product mockup and front print artwork against: "
        "(1) the user's design brief, (2) the company's real brand look from the web "
        "and any structured brand kit, and (3) basic print-merch quality "
        "(legibility, contrast, no garbled text, cohesive composition). "
        "COLOR is critical: if the print uses invented gold/metallic/cream accents "
        "when the real brand uses purple, blue, teal, green, etc., you MUST request "
        "a redo and name the correct hexes. Approve only if the design is a good "
        "match; otherwise request a redo with concrete instructions an image model "
        "can follow. Respond with JSON only."
    )

    user_text = (
        f'Company: "{company_name}"\n'
        f'Candidate / player name: "{candidate_name}"\n'
        f"Product type: {product_type}\n"
        f"Blank / garment color: {color_line}\n"
        f"User design brief:\n{brief}\n\n"
        f"Structured brand kit:\n{_brand_summary(brand, has_logo_ref=has_logo_ref)}\n\n"
        f"Generation brief used for this attempt:\n{generation_brief}\n\n"
        "Images (in order):\n"
        "1) Style mockup of the product\n"
        "2) Front print artwork (transparent/print layer)\n"
        + ("3) Real company logo reference\n" if logo_png else "")
        + "\nSearch the web for this company's branding, then return JSON:\n"
        "{\n"
        '  "decision": "approve" | "redo",\n'
        '  "score": <0-10 number>,\n'
        '  "brand_alignment": "<short notes vs real company brand>",\n'
        '  "prompt_alignment": "<short notes vs user design brief>",\n'
        '  "issues": ["<specific problems>"],\n'
        '  "redo_instructions": "<concrete prompt deltas for the image model; '
        'empty if approve>"\n'
        "}"
    )

    images: list[bytes] = [mockup_png, front_png]
    if logo_png:
        images.append(logo_png)

    data: dict[str, Any] | None = None
    try:
        data = await chat_json_multimodal(
            system,
            user_text,
            images,
            enable_web_search=True,
            timeout=120.0,
        )
    except OpenRouterChatError:
        log.exception(
            "design critic with web search failed; retrying without web search"
        )
        try:
            data = await chat_json_multimodal(
                system,
                user_text
                + "\n\n(Web search unavailable — judge using the structured brand kit "
                "and images only.)",
                images,
                enable_web_search=False,
                timeout=120.0,
            )
        except OpenRouterChatError:
            log.exception("design critic call failed; soft-approving to avoid blocking")
            return DesignReview(
                decision="approve",
                score=0.0,
                brand_alignment="Critic unavailable — skipped.",
                prompt_alignment="Critic unavailable — skipped.",
                issues=["Design critic failed; proceeding without redo."],
                redo_instructions="",
                attempt=attempt,
            )

    review = _normalize_review(data, attempt=attempt)
    log.info(
        "design review attempt=%s decision=%s score=%s issues=%d",
        attempt,
        review.decision,
        review.score,
        len(review.issues),
    )
    return review
