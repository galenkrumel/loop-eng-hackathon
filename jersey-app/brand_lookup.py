"""Look up real company brand data (logos, colors, slogan) before image generation.

Tries, in order:
1. Context.dev / Brand.dev API key (BRAND_DEV_API_KEY or CONTEXT_DEV_API_KEY)
2. Zero CLI paid Brand.dev capability (when authenticated + funded)

Failures are soft — callers should fall back to name-only inference.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import shutil
import subprocess
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import quote, urljoin

import httpx

log = logging.getLogger("jersey.brand")

CONTEXT_RETRIEVE_URL = "https://api.context.dev/v1/brand/retrieve"
BRAND_DEV_BY_NAME_URL = "https://api.brand.dev/v1/brand/retrieve-by-name"
ZERO_MPP_BY_NAME_URL = (
    "https://mpp.orthogonal.com/brand-dev/v1/brand/retrieve-by-name"
)
ZERO_CAPABILITY_SLUG = "brand-dev-api-brand-dev-retrieve-by-name-c0e16954"

_RASTER_EXTS = (".png", ".jpg", ".jpeg", ".webp", ".gif")
_SVG_HINTS = (".svg", "image/svg")


@dataclass
class BrandProfile:
    """Normalized brand kit used to enrich gpt-image-2 prompts/refs."""

    title: str = ""
    domain: str = ""
    slogan: str = ""
    color_hexes: list[str] = field(default_factory=list)
    logo_urls: list[str] = field(default_factory=list)
    source: str = ""

    @property
    def has_visual_cues(self) -> bool:
        return bool(self.color_hexes or self.logo_urls or self.slogan)


class BrandLookupError(RuntimeError):
    """Raised only for unexpected parse bugs; lookup helpers catch and soften."""


def _api_key() -> str:
    return (
        os.getenv("BRAND_DEV_API_KEY", "").strip()
        or os.getenv("CONTEXT_DEV_API_KEY", "").strip()
    )


def _resolve_zero_bin() -> str | None:
    env = os.getenv("ZERO_RUNNER", "").strip()
    if env and Path(env).is_file() and os.access(env, os.X_OK):
        return env
    which = shutil.which("zero")
    if which:
        return which
    home = Path.home() / ".zero" / "runtime" / "bin" / "zero"
    if home.is_file() and os.access(home, os.X_OK):
        return str(home)
    return None


def _hexes_from_colors(colors: Any) -> list[str]:
    out: list[str] = []
    if not isinstance(colors, list):
        return out
    for item in colors:
        if isinstance(item, dict):
            hex_val = str(item.get("hex") or "").strip()
        else:
            hex_val = str(item or "").strip()
        if hex_val and not hex_val.startswith("#"):
            hex_val = f"#{hex_val}"
        if hex_val and hex_val not in out:
            out.append(hex_val)
    return out


def _is_raster_url(url: str) -> bool:
    lower = url.lower().split("?", 1)[0]
    if any(lower.endswith(ext) for ext in _RASTER_EXTS):
        return True
    if any(hint in lower for hint in _SVG_HINTS):
        return False
    # Unknown extension — treat as usable (Brand.dev often serves jpg without ext quirks)
    return True


def _logo_urls_from_brand(brand: dict[str, Any]) -> list[str]:
    logos = brand.get("logos") or []
    if not isinstance(logos, list):
        return []

    scored: list[tuple[int, str]] = []
    for logo in logos:
        if not isinstance(logo, dict):
            continue
        url = str(logo.get("url") or "").strip()
        if not url.startswith(("http://", "https://")):
            continue
        if not _is_raster_url(url):
            continue
        logo_type = str(logo.get("type") or "").lower()
        mode = str(logo.get("mode") or "").lower()
        score = 0
        if logo_type == "logo":
            score += 30
        elif logo_type == "icon":
            score += 20
        if "transparent" in mode or mode == "light":
            score += 5
        if mode == "has_opaque_background":
            score += 2
        scored.append((score, url))

    scored.sort(key=lambda pair: pair[0], reverse=True)
    # Dedupe preserving score order
    seen: set[str] = set()
    urls: list[str] = []
    for _, url in scored:
        if url not in seen:
            seen.add(url)
            urls.append(url)
    return urls


def parse_brand_payload(payload: Any, *, source: str) -> BrandProfile | None:
    """Normalize Brand.dev / Context.dev JSON into BrandProfile."""
    if not isinstance(payload, dict):
        return None

    brand = payload.get("brand")
    if not isinstance(brand, dict):
        # Some wrappers nest under data
        data = payload.get("data")
        if isinstance(data, dict) and isinstance(data.get("brand"), dict):
            brand = data["brand"]
        elif "logos" in payload or "colors" in payload or "title" in payload:
            brand = payload
        else:
            return None

    title = str(brand.get("title") or brand.get("name") or "").strip()
    domain = str(brand.get("domain") or "").strip()
    slogan = str(brand.get("slogan") or brand.get("description") or "").strip()
    colors = _hexes_from_colors(brand.get("colors"))
    logos = _logo_urls_from_brand(brand)

    profile = BrandProfile(
        title=title,
        domain=domain,
        slogan=slogan[:240],
        color_hexes=colors[:8],
        logo_urls=logos,
        source=source,
    )
    if not profile.has_visual_cues and not profile.title:
        return None
    return profile


async def _lookup_via_api_key(company_name: str) -> BrandProfile | None:
    key = _api_key()
    if not key:
        return None

    name = company_name.strip()[:30]
    if len(name) < 3:
        return None

    headers = {
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
        "Accept": "application/json",
    }

    async with httpx.AsyncClient(timeout=45.0) as client:
        # Prefer Context.dev unified retrieve
        try:
            resp = await client.post(
                CONTEXT_RETRIEVE_URL,
                headers=headers,
                json={"type": "by_name", "name": name, "maxSpeed": True},
            )
            if resp.status_code < 400:
                profile = parse_brand_payload(resp.json(), source="context.dev")
                if profile:
                    return profile
            log.warning(
                "context.dev by_name status=%s body=%s",
                resp.status_code,
                resp.text[:300],
            )
        except Exception:
            log.exception("context.dev retrieve failed")

        # Legacy Brand.dev GET
        try:
            resp = await client.get(
                BRAND_DEV_BY_NAME_URL,
                headers={"Authorization": f"Bearer {key}", "Accept": "application/json"},
                params={"name": name},
            )
            if resp.status_code < 400:
                profile = parse_brand_payload(resp.json(), source="brand.dev")
                if profile:
                    return profile
            log.warning(
                "brand.dev by_name status=%s body=%s",
                resp.status_code,
                resp.text[:300],
            )
        except Exception:
            log.exception("brand.dev retrieve-by-name failed")

    return None


def _zero_fetch_sync(company_name: str, zero_bin: str) -> BrandProfile | None:
    name = company_name.strip()[:30]
    if len(name) < 3:
        return None
    url = f"{ZERO_MPP_BY_NAME_URL}?name={quote(name)}"
    cmd = [
        zero_bin,
        "fetch",
        "--json",
        "--capability",
        ZERO_CAPABILITY_SLUG,
        "--max-pay",
        "0.10",
        "--timeout",
        "90",
        url,
    ]

    try:
        completed = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=120,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        log.warning("zero fetch failed to run: %s", exc)
        return None

    if completed.returncode != 0:
        log.warning(
            "zero fetch exit=%s stderr=%s",
            completed.returncode,
            (completed.stderr or "")[:400],
        )
        return None

    raw = (completed.stdout or "").strip()
    if not raw:
        return None
    try:
        envelope = json.loads(raw)
    except json.JSONDecodeError:
        log.warning("zero fetch returned non-JSON stdout")
        return None

    # --json envelope: {ok, body, bodyRaw, ...} or bare brand payload
    body: Any = envelope
    if isinstance(envelope, dict) and "ok" in envelope:
        if not envelope.get("ok"):
            log.warning("zero fetch ok=false status=%s", envelope.get("status"))
            return None
        body = envelope.get("body")
        if body is None and envelope.get("bodyRaw"):
            try:
                body = json.loads(str(envelope["bodyRaw"]))
            except json.JSONDecodeError:
                body = None

    return parse_brand_payload(body, source="zero")


async def _lookup_via_zero(company_name: str) -> BrandProfile | None:
    zero_bin = _resolve_zero_bin()
    if not zero_bin:
        return None
    # Skip Zero unless explicitly enabled or no API key (auto-try)
    force = os.getenv("BRAND_LOOKUP_VIA_ZERO", "").strip().lower() in {
        "1",
        "true",
        "yes",
    }
    if _api_key() and not force:
        return None
    return await asyncio.to_thread(_zero_fetch_sync, company_name, zero_bin)


async def lookup_brand(company_name: str) -> BrandProfile | None:
    """Resolve brand kit for a company name. Never raises — returns None on miss."""
    name = (company_name or "").strip()
    if len(name) < 3:
        log.info("brand lookup skipped — name too short (%r)", name)
        return None

    disabled = os.getenv("BRAND_LOOKUP_DISABLED", "").strip().lower() in {
        "1",
        "true",
        "yes",
    }
    if disabled:
        log.info("brand lookup disabled via BRAND_LOOKUP_DISABLED")
        return None

    try:
        profile = await _lookup_via_api_key(name)
        if profile:
            log.info(
                "brand lookup ok source=%s title=%r domain=%r colors=%d logos=%d",
                profile.source,
                profile.title,
                profile.domain,
                len(profile.color_hexes),
                len(profile.logo_urls),
            )
            return profile

        profile = await _lookup_via_zero(name)
        if profile:
            log.info(
                "brand lookup ok source=%s title=%r domain=%r colors=%d logos=%d",
                profile.source,
                profile.title,
                profile.domain,
                len(profile.color_hexes),
                len(profile.logo_urls),
            )
            return profile
    except Exception:
        log.exception("brand lookup unexpected error for %r", name)
        return None

    log.info("brand lookup miss for %r — falling back to name inference", name)
    return None


def _parse_hex(hex_val: str) -> tuple[int, int, int] | None:
    raw = hex_val.strip().lstrip("#")
    if len(raw) == 3:
        raw = "".join(ch * 2 for ch in raw)
    if len(raw) != 6:
        return None
    try:
        return int(raw[0:2], 16), int(raw[2:4], 16), int(raw[4:6], 16)
    except ValueError:
        return None


def _is_near_neutral(hex_val: str) -> bool:
    """True for near-black, near-white, or low-chroma grays — useless print accents."""
    rgb = _parse_hex(hex_val)
    if not rgb:
        return True
    r, g, b = rgb
    chroma = (max(r, g, b) - min(r, g, b)) / 255.0
    if chroma < 0.14:
        return True
    luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255.0
    return luminance < 0.08 or luminance > 0.92


def chromatic_hexes(hexes: list[str]) -> list[str]:
    """Brand colors that are actually usable as print accents (not pure neutrals)."""
    return [h for h in hexes if not _is_near_neutral(h)]


def palette_needs_enrichment(hexes: list[str]) -> bool:
    """Brand.dev often returns only a near-black logo ink — treat that as missing."""
    return len(chromatic_hexes(hexes)) == 0


def _normalize_hex(raw: str) -> str | None:
    h = raw.strip().lstrip("#")
    if len(h) == 3:
        h = "".join(ch * 2 for ch in h)
    if len(h) != 6:
        return None
    try:
        int(h, 16)
    except ValueError:
        return None
    return f"#{h.lower()}"


def _guess_domain(company_name: str, brand: BrandProfile | None) -> str | None:
    if brand and brand.domain:
        return brand.domain.strip().lower().lstrip(".")
    # Very light heuristic — only for enrichment, never authoritative.
    slug = re.sub(r"[^a-z0-9]+", "", company_name.strip().lower())
    if len(slug) >= 3:
        return f"{slug}.com"
    return None


async def _colors_from_website(domain: str) -> list[str]:
    """Scrape homepage + linked CSS for frequent chromatic hexes."""
    base = f"https://{domain}"
    counts: Counter[str] = Counter()

    async with httpx.AsyncClient(timeout=25.0, follow_redirects=True) as client:
        try:
            home = await client.get(base)
        except Exception:
            log.exception("website color scrape failed for %s", domain)
            return []
        if home.status_code >= 400 or not home.text:
            return []

        html = home.text
        for match in re.findall(r"#[0-9A-Fa-f]{3,6}\b", html):
            norm = _normalize_hex(match)
            if norm and not _is_near_neutral(norm):
                counts[norm] += 1

        hrefs = re.findall(
            r'(?:href|src)=["\']([^"\']+\.css[^"\']*)["\']',
            html,
            flags=re.IGNORECASE,
        )
        # Prefer same-origin stylesheets; cap requests.
        seen: set[str] = set()
        for href in hrefs:
            url = urljoin(base + "/", href)
            if url in seen:
                continue
            seen.add(url)
            if len(seen) > 6:
                break
            try:
                css = await client.get(url)
            except Exception:
                continue
            if css.status_code >= 400 or not css.text:
                continue
            for match in re.findall(r"#[0-9A-Fa-f]{6}\b", css.text):
                norm = _normalize_hex(match)
                if norm and not _is_near_neutral(norm):
                    counts[norm] += 1

    if not counts:
        return []
    # Prefer frequently used accents; keep top distinct hues.
    ranked = [hex_val for hex_val, _ in counts.most_common(24)]
    log.info(
        "website palette domain=%s top=%s",
        domain,
        [(h, counts[h]) for h in ranked[:8]],
    )
    return ranked[:8]


async def enrich_brand_colors(company_name: str, brand: BrandProfile | None) -> BrandProfile | None:
    """Fill in real brand palette when Brand.dev/Zero only have neutrals.

    Prefer scraping the company website CSS (deterministic). Fall back to
    OpenRouter web search. Never accept an all-gray enrichment result.
    """
    if brand and not palette_needs_enrichment(brand.color_hexes):
        return brand

    name = (company_name or (brand.title if brand else "") or "").strip()
    if len(name) < 3:
        return brand

    useful: list[str] = []
    source_note = ""

    domain = _guess_domain(name, brand)
    if domain:
        useful = await _colors_from_website(domain)
        if useful:
            source_note = f"website:{domain}"

    if not useful:
        try:
            from openrouter_chat import chat_json_web

            domain_hint = f" ({domain})" if domain else ""
            data = await chat_json_web(
                system=(
                    "You are a brand identity researcher. Search the web for the company's "
                    "real visual identity (website CSS, press kit, app UI). "
                    "Return ONLY saturated chromatic brand accents as hex codes "
                    "(purple, violet, blue, teal, green, red, orange, pink, etc.). "
                    "NEVER return black, white, gray, charcoal, off-white, cream, or "
                    "metallic gold unless the brand is literally monochrome gold. "
                    "Respond with JSON only."
                ),
                user=(
                    f'Company: "{name}"{domain_hint}\n'
                    "Brand.dev only returned near-black/neutral hexes — ignore those.\n"
                    "Search the live website and brand pages, then return JSON:\n"
                    "{\n"
                    '  "colors": ["#RRGGBB", "..."],\n'
                    '  "notes": "<one short sentence naming the source>"\n'
                    "}"
                ),
                timeout=90.0,
            )
            enriched = _hexes_from_colors(data.get("colors"))
            useful = chromatic_hexes(enriched)
            source_note = str(data.get("notes") or "web-search").strip()
        except Exception:
            log.exception("brand color enrichment (web search) failed for %r", name)
            return brand

    useful = chromatic_hexes(useful)
    if not useful:
        log.info("brand color enrichment found no chromatic hexes for %r", name)
        return brand

    log.info(
        "brand colors enriched for %r → %s (%s)",
        name,
        useful,
        source_note or "no notes",
    )

    if brand is None:
        return BrandProfile(
            title=name,
            domain=domain or "",
            color_hexes=useful[:8],
            source="web-enrichment",
        )

    merged: list[str] = []
    for hex_val in useful + brand.color_hexes:
        if hex_val not in merged:
            merged.append(hex_val)
    brand.color_hexes = merged[:8]
    if brand.source and "enriched" not in brand.source and "+web" not in brand.source:
        brand.source = f"{brand.source}+web"
    return brand


def brand_prompt_guidance(
    brand: BrandProfile | None,
    *,
    has_logo_ref: bool,
) -> str:
    """Text fragment injected into print prompts."""
    if not brand or not brand.has_visual_cues:
        return (
            "Infer a cohesive brand crest or wordmark (colors, typography, motifs) "
            "from the company name. Use that company's real public brand colors — "
            "do NOT invent gold, metallic foil, or cream accents unless they are "
            "part of the real brand."
        )

    parts: list[str] = []
    label = brand.title or "the company"
    if brand.domain:
        parts.append(f"Official brand for {label} ({brand.domain}).")
    else:
        parts.append(f"Official brand for {label}.")

    accents = chromatic_hexes(brand.color_hexes)
    if accents:
        parts.append(
            f"MANDATORY print ink palette (use these hexes as the dominant colors): "
            f"{', '.join(accents)}. Do not substitute gold, brass, metallic yellow, "
            f"cream, or other invented accents."
        )
    elif brand.color_hexes:
        parts.append(f"Known brand colors: {', '.join(brand.color_hexes)}.")

    if brand.slogan:
        parts.append(f'Brand line: "{brand.slogan}".')
    if has_logo_ref:
        parts.append(
            "The first reference image is the real company logo — preserve its exact "
            "shape and lettering. If the reference is monochrome/dark, RECOLOR it using "
            "the mandatory brand ink palette above (do not keep it black-on-black and "
            "do not invent gold). Adapt into athletic jersey print artwork; do not invent "
            "a different logo mark."
        )
    else:
        parts.append(
            "Match the company's real visual identity as closely as possible from these "
            "brand details; do not invent unrelated motifs or color schemes."
        )
    return " ".join(parts)


async def download_preferred_logo(
    brand: BrandProfile,
) -> tuple[bytes, str] | None:
    """Download the best raster logo. Returns (bytes, media_type) or None."""
    if not brand.logo_urls:
        return None

    async with httpx.AsyncClient(timeout=30.0, follow_redirects=True) as client:
        for url in brand.logo_urls[:5]:
            try:
                resp = await client.get(url)
                if resp.status_code >= 400 or not resp.content:
                    continue
                ctype = (resp.headers.get("content-type") or "").split(";")[0].strip().lower()
                if "svg" in ctype or url.lower().split("?", 1)[0].endswith(".svg"):
                    continue
                if ctype.startswith("image/"):
                    media = ctype
                elif url.lower().endswith(".png"):
                    media = "image/png"
                elif url.lower().endswith((".jpg", ".jpeg")):
                    media = "image/jpeg"
                elif url.lower().endswith(".webp"):
                    media = "image/webp"
                else:
                    media = "image/png"
                if len(resp.content) < 64:
                    continue
                log.info("downloaded brand logo %s (%d bytes, %s)", url, len(resp.content), media)
                return resp.content, media
            except Exception:
                log.exception("logo download failed for %s", url)
    return None
