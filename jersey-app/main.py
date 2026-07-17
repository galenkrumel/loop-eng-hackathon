"""Merch design + try-on app (tee, hat, mug)."""

from __future__ import annotations

import asyncio
import logging
import re
import uuid
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from brand_lookup import (
    BrandProfile,
    brand_prompt_guidance,
    chromatic_hexes,
    download_preferred_logo,
    enrich_brand_colors,
    lookup_brand,
)
from candidates_file import (
    Candidate,
    CandidatesFileError,
    parse_candidates_file,
    parse_candidates_text,
)
from design_critic import DesignReview, max_review_attempts, review_design
from openrouter_chat import OpenRouterChatError, chat_json
from openrouter_images import (
    OpenRouterImageError,
    generate_image,
    reference_from_bytes,
    to_data_url,
)
from printify_client import (
    FALLBACK_COLORS,
    PRODUCT_TYPES,
    PrintifyError,
    get_product_config,
    list_catalog_colors,
    upload_and_create_draft,
)
from transparency import ensure_transparent_background

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("jersey")

APP_DIR = Path(__file__).resolve().parent
load_dotenv(APP_DIR / ".env")

OUTPUTS_DIR = APP_DIR / "outputs"
OUTPUTS_DIR.mkdir(exist_ok=True)

STATIC_DIR = APP_DIR / "static"

app = FastAPI(title="Jersey Design App")
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

FRONT_BACK_ASPECT = "3:4"
SQUARE_ASPECT = "1:1"
# Hat front panel ~1500×600 (~2.5:1); mug wrap ~2475×1155 (~2.1:1).
# OpenRouter gpt-image-2 only allows a fixed aspect_ratio enum (no "3:1").
WIDE_PANEL_ASPECT = "2:1"
MUG_WRAP_ASPECT = "2:1"

_DARK_NAME_HINTS = (
    "black",
    "navy",
    "forest",
    "olive",
    "maroon",
    "asphalt",
    "charcoal",
    "dark",
    "military",
    "evergreen",
    "oxblood",
    "brown",
    "purple",
    "teal",
    "royal",
    "red",
    "cardinal",
    "berry",
    "rust",
    "army",
    "storm",
    "slate",
    "midnight",
    "team navy",
    "team purple",
    "deep",
    "coal",
    "espresso",
)


def _slug(text: str) -> str:
    cleaned = re.sub(r"[^a-zA-Z0-9]+", "-", text.strip().lower()).strip("-")
    return cleaned[:40] or "item"


def _normalize_product_type(raw: str | None) -> str:
    key = (raw or "tee").strip().lower()
    aliases = {
        "t-shirt": "tee",
        "tshirt": "tee",
        "shirt": "tee",
        "jersey": "tee",
        "cap": "hat",
        "baseball cap": "hat",
        "coffee mug": "mug",
    }
    key = aliases.get(key, key)
    if key not in PRODUCT_TYPES:
        raise HTTPException(
            status_code=400,
            detail=f"product_type must be one of: {', '.join(sorted(PRODUCT_TYPES))}",
        )
    return key


def _shirt_is_dark(blank_color: str, ink_hint: str | None = None) -> bool:
    if ink_hint in {"light", "light_ink", "white_ink"}:
        return True
    if ink_hint in {"dark", "dark_ink", "black_ink"}:
        return False
    lower = blank_color.lower()
    return any(hint in lower for hint in _DARK_NAME_HINTS)


def _ink_guidance(
    blank_color: str,
    ink_hint: str | None = None,
    *,
    brand: BrandProfile | None = None,
) -> str:
    accents = chromatic_hexes(brand.color_hexes) if brand else []
    accent_bit = (
        f" Prefer these brand accent hexes as the colorful inks: {', '.join(accents)}."
        if accents
        else ""
    )
    if _shirt_is_dark(blank_color, ink_hint):
        if accents:
            return (
                f"The blank product is {blank_color} (dark / saturated). Use high-contrast "
                f"ink from the brand palette (plus white for highlights if needed) so the "
                f"print reads clearly on {blank_color}.{accent_bit} Do not invent gold, "
                f"brass, or cream metallic accents."
            )
        return (
            f"The blank product is {blank_color} (dark / saturated). Use light / high-contrast "
            f"ink so the print reads clearly on {blank_color}. Prefer real brand colors over "
            f"invented gold or metallic yellow."
        )
    if accents:
        return (
            f"The blank product is {blank_color} (light / pale). Use dark / high-contrast ink "
            f"from the brand palette so the print reads clearly on {blank_color}.{accent_bit}"
        )
    return (
        f"The blank product is {blank_color} (light / pale). Use dark / high-contrast ink "
        f"(black, navy, deep brand colors) so the print reads clearly on {blank_color}."
    )


def _print_art_rules(
    blank_color: str | None,
    ink_hint: str | None = None,
    *,
    brand: BrandProfile | None = None,
) -> str:
    contrast = (
        _ink_guidance(blank_color, ink_hint, brand=brand)
        if blank_color
        else (
            "Design for a white ceramic mug — use saturated, high-contrast colors that read "
            "clearly on white."
            + (
                f" Prefer brand accent hexes: {', '.join(chromatic_hexes(brand.color_hexes))}."
                if brand and chromatic_hexes(brand.color_hexes)
                else ""
            )
        )
    )
    return (
        "CRITICAL BACKGROUND: output a PNG with a TRUE transparent alpha channel. "
        "If the model cannot emit alpha, fill ONLY the empty backdrop with a flat solid "
        "chroma-key color #00FF00 (pure green) and put NOTHING else on that green — no "
        "gradients, no checkerboard, no paper texture, no white matte. "
        "Print-ready flat graphic only: no product silhouette, no fabric/ceramic photo, no "
        "mockup frame, no hanger, no 3D product shot. Sharp high-contrast vector-like artwork "
        f"suitable for DTG/DTF/sublimation. {contrast} "
        "Centered composition, no watermark, no extra people or scenery."
    )


def _user_brief_block(design_prompt: str | None) -> str:
    brief = (design_prompt or "").strip()
    if not brief:
        return ""
    return f" USER DESIGN BRIEF (follow closely): {brief}."


def _redo_block(redo_instructions: str | None) -> str:
    redo = (redo_instructions or "").strip()
    if not redo:
        return ""
    return (
        " CRITICAL REVISION FROM DESIGN QA (must apply): "
        f"{redo}"
    )


def front_print_prompt(
    company_name: str,
    blank_color: str,
    ink_hint: str | None = None,
    *,
    brand: BrandProfile | None = None,
    has_logo_ref: bool = False,
    design_prompt: str | None = None,
    redo_instructions: str | None = None,
) -> str:
    guidance = brand_prompt_guidance(brand, has_logo_ref=has_logo_ref)
    return (
        f'Create a front-chest print graphic for the company "{company_name}" that will be '
        f"printed on a {blank_color} Bella+Canvas 3001 tee. {guidance} Athletic sports-jersey "
        f"style emblem for the center chest."
        f"{_user_brief_block(design_prompt)}"
        f"{_redo_block(redo_instructions)} "
        f"{_print_art_rules(blank_color, ink_hint, brand=brand)}"
    )


def back_print_prompt(
    candidate_name: str,
    blank_color: str,
    ink_hint: str | None = None,
    *,
    brand: BrandProfile | None = None,
    design_prompt: str | None = None,
    redo_instructions: str | None = None,
) -> str:
    color_bit = ""
    accents = chromatic_hexes(brand.color_hexes) if brand else []
    if accents:
        color_bit = (
            f" Prefer lettering colors from the brand palette "
            f"({', '.join(accents)}) while staying high-contrast on {blank_color}. "
            f"Do not use gold/metallic yellow unless those hexes are in the palette."
        )
    elif brand and brand.color_hexes:
        color_bit = (
            f" Prefer lettering colors that harmonize with brand palette "
            f"({', '.join(brand.color_hexes)}) while staying high-contrast on {blank_color}."
        )
    return (
        f'Create a back-of-jersey name print: the player name "{candidate_name}" in large '
        f"classic athletic block lettering (bold, arched or straight). Designed for a "
        f"{blank_color} tee — letters must contrast strongly with {blank_color}.{color_bit}"
        f"{_user_brief_block(design_prompt)}"
        f"{_redo_block(redo_instructions)} "
        f"No shirt body, no number required unless it fits cleanly under the name. "
        f"{_print_art_rules(blank_color, ink_hint, brand=brand)}"
    )


def sleeve_print_prompt(
    company_name: str,
    blank_color: str,
    ink_hint: str | None = None,
    *,
    brand: BrandProfile | None = None,
    has_logo_ref: bool = False,
    design_prompt: str | None = None,
    redo_instructions: str | None = None,
) -> str:
    guidance = brand_prompt_guidance(brand, has_logo_ref=has_logo_ref)
    return (
        f'Create a small square sleeve print mark for "{company_name}" on a {blank_color} tee: '
        f"{guidance} Simplified crest or logo that reads clearly at sleeve size. Keep it "
        f"minimal."
        f"{_user_brief_block(design_prompt)}"
        f"{_redo_block(redo_instructions)} "
        f"{_print_art_rules(blank_color, ink_hint, brand=brand)}"
    )


def neck_print_prompt(
    company_name: str,
    blank_color: str,
    ink_hint: str | None = None,
    *,
    brand: BrandProfile | None = None,
    has_logo_ref: bool = False,
    design_prompt: str | None = None,
    redo_instructions: str | None = None,
) -> str:
    guidance = brand_prompt_guidance(brand, has_logo_ref=has_logo_ref)
    return (
        f'Create a small inside-neck label graphic for "{company_name}" on a {blank_color} tee: '
        f"{guidance} Compact wordmark or logo sized for a neck tag, clean and legible at "
        f"small print size."
        f"{_user_brief_block(design_prompt)}"
        f"{_redo_block(redo_instructions)} "
        f"{_print_art_rules(blank_color, ink_hint, brand=brand)}"
    )


def hat_front_prompt(
    company_name: str,
    blank_color: str,
    ink_hint: str | None = None,
    *,
    brand: BrandProfile | None = None,
    has_logo_ref: bool = False,
    design_prompt: str | None = None,
    redo_instructions: str | None = None,
) -> str:
    guidance = brand_prompt_guidance(brand, has_logo_ref=has_logo_ref)
    return (
        f'Create a wide front-panel baseball-cap print for "{company_name}" on a '
        f"{blank_color} hat. {guidance} Horizontal crest / wordmark that fits a curved cap "
        f"front (roughly 2.5:1). Keep it bold and simple for DTF."
        f"{_user_brief_block(design_prompt)}"
        f"{_redo_block(redo_instructions)} "
        f"{_print_art_rules(blank_color, ink_hint, brand=brand)}"
    )


def mug_front_prompt(
    company_name: str,
    candidate_name: str,
    *,
    brand: BrandProfile | None = None,
    has_logo_ref: bool = False,
    design_prompt: str | None = None,
    redo_instructions: str | None = None,
) -> str:
    guidance = brand_prompt_guidance(brand, has_logo_ref=has_logo_ref)
    return (
        f'Create a wide mug wrap graphic for "{company_name}" featuring the name '
        f'"{candidate_name}". {guidance} Landscape layout (~2:1) for an 11oz ceramic mug wrap: '
        f"brand crest plus candidate name, festive or athletic merch style."
        f"{_user_brief_block(design_prompt)}"
        f"{_redo_block(redo_instructions)} "
        f"{_print_art_rules(None, brand=brand)}"
    )


def style_mockup_prompt(
    product_type: str,
    company_name: str,
    candidate_name: str,
    blank_color: str | None,
    *,
    design_prompt: str | None = None,
    redo_instructions: str | None = None,
) -> str:
    extra = f"{_user_brief_block(design_prompt)}{_redo_block(redo_instructions)}"
    if product_type == "hat":
        return (
            f'Create a photorealistic baseball cap product mockup for "{company_name}". '
            f"The blank hat MUST be {blank_color}. Place the reference front-panel artwork on "
            f"the front of the cap. Clean neutral background, sharp readable branding, no "
            f"watermark, no extra people.{extra}"
        )
    if product_type == "mug":
        return (
            f'Create a photorealistic white ceramic mug product mockup for "{company_name}" '
            f'with "{candidate_name}" on the wrap. Use the reference artwork as the printed '
            f"design on the mug. Clean neutral background, sharp readable branding, no "
            f"watermark, no extra people.{extra}"
        )
    return (
        f'Create a photorealistic sports jersey / t-shirt product mockup for "{company_name}" '
        f'with the player name "{candidate_name}". The blank garment MUST be a {blank_color} '
        f"short-sleeve tee (exact shirt color: {blank_color}), not white unless the color is "
        f"White. Use the reference images as the exact print artwork: place the front crest on "
        f"the chest and imagine the name print on the back. Front-view flat or lightly worn "
        f"jersey on a clean neutral background, athletic cut, sharp readable branding, no "
        f"watermark, no extra people.{extra}"
    )


def tryon_prompt(
    product_type: str,
    company_name: str,
    candidate_name: str,
    blank_color: str | None,
) -> str:
    if product_type == "hat":
        return (
            f"Using the reference photos: keep the exact likeness of the person in the first "
            f"image. Put the {blank_color} branded baseball cap from the second reference on "
            f"their head ({company_name}). Natural portrait, photorealistic, clean background. "
            f"Do not change identity. No watermark."
        )
    if product_type == "mug":
        return (
            f"Using the reference photos: keep the exact likeness of the person in the first "
            f"image. Have them hold the branded mug from the second reference "
            f'({company_name}, name "{candidate_name}"). Natural portrait, photorealistic, '
            f"clean background. Do not change identity. No watermark."
        )
    return (
        f"Using the reference photos: keep the exact likeness, face, hair, and body of the "
        f"person in the first reference image. Dress them in the sports jersey from the "
        f"second reference image (the {blank_color} {company_name} jersey with the name "
        f'"{candidate_name}"). Keep the shirt color as {blank_color}. Natural standing or '
        f"three-quarter portrait, realistic fabric fit and folds, consistent lighting, "
        f"photorealistic. Do not change the person's identity. Clean background. No watermark."
    )


async def choose_blank_color(
    company_name: str,
    available_colors: list[str],
    *,
    product_label: str = "t-shirt",
    brand: BrandProfile | None = None,
) -> tuple[str, str, str]:
    """Pick a Printify blank color from the catalog.

    Returns (color, reason, ink_hint).
    """
    colors = available_colors or sorted(FALLBACK_COLORS)
    choices = ", ".join(colors)
    brand_bits = ""
    if brand:
        accents = chromatic_hexes(brand.color_hexes)
        if accents:
            brand_bits += f"Primary chromatic brand hexes: {', '.join(accents)}.\n"
        elif brand.color_hexes:
            brand_bits += f"Known brand palette hexes: {', '.join(brand.color_hexes)}.\n"
        if brand.slogan:
            brand_bits += f'Brand slogan: "{brand.slogan}".\n'
        if brand.domain:
            brand_bits += f"Domain: {brand.domain}.\n"
    data = await chat_json(
        system=(
            f"You are a merch art director. Choose exactly one {product_label} blank color "
            "from the allowed Printify catalog list (copy the string EXACTLY). Prefer a "
            "color that fits the brand and gives strong contrast for prints. When brand "
            "hexes are provided, pick a blank that lets those brand colors print clearly "
            "(often black/navy/white rather than inventing a clash). Also say "
            "whether print ink should be light (for dark/saturated blanks) or dark (for "
            "light/pale blanks). Respond with JSON only."
        ),
        user=(
            f'Company / brand name: "{company_name}"\n'
            f"{brand_bits}"
            f"Product: {product_label}\n"
            f"Allowed Printify colors ({len(colors)} exact strings): [{choices}]\n"
            'Return JSON: {"color": "<one exact allowed color>", '
            '"ink": "light" | "dark", "reason": "<one short sentence>"}'
        ),
    )
    raw = str(data.get("color") or "").strip()
    reason = str(data.get("reason") or "").strip()
    ink_raw = str(data.get("ink") or "").strip().lower()
    ink_hint = (
        "light"
        if ink_raw.startswith("light")
        else "dark"
        if ink_raw.startswith("dark")
        else ""
    )

    matched = next((c for c in colors if c.lower() == raw.lower()), None)
    if matched is None:
        soft = [
            c
            for c in colors
            if c.lower() in raw.lower() or raw.lower() in c.lower()
        ]
        matched = (
            max(soft, key=len)
            if soft
            else ("Black" if "Black" in colors else colors[0])
        )
        log.warning("color normalize %r → %r", raw, matched)
    if not ink_hint:
        ink_hint = "light" if _shirt_is_dark(matched) else "dark"
    return matched, reason or f"Selected {matched} for brand contrast.", ink_hint


# Backwards-compatible alias used by smoke tests
async def choose_shirt_color(
    company_name: str,
    available_colors: list[str],
) -> tuple[str, str, str]:
    return await choose_blank_color(company_name, available_colors)


def _transparent_layer(image_bytes: bytes) -> bytes:
    return ensure_transparent_background(image_bytes)


async def _generate_print_and_mockup(
    *,
    ptype: str,
    company: str,
    candidate: str,
    blank_color: str | None,
    ink_hint: str | None,
    brand: BrandProfile | None,
    has_logo_ref: bool,
    brand_refs: list[dict] | None,
    design_prompt: str,
    redo_instructions: str | None,
    prior_front: bytes | None = None,
) -> tuple[bytes, bytes, bytes, bytes, bytes, str]:
    """Generate print layers + style mockup. Returns front/back/sleeve/neck/mockup + front prompt."""
    front_bytes = back_bytes = sleeve_bytes = neck_bytes = b""

    # Soft-reference prior front on redo so the image model can revise rather than start over.
    print_refs = list(brand_refs or [])
    if prior_front:
        print_refs.append(reference_from_bytes(prior_front, "image/png"))
    refs_or_none = print_refs or None

    if ptype == "tee":
        assert blank_color is not None
        front_prompt = front_print_prompt(
            company,
            blank_color,
            ink_hint,
            brand=brand,
            has_logo_ref=has_logo_ref,
            design_prompt=design_prompt,
            redo_instructions=redo_instructions,
        )
        front_raw, back_raw, sleeve_raw, neck_raw = await asyncio.gather(
            generate_image(
                front_prompt,
                references=refs_or_none,
                aspect_ratio=FRONT_BACK_ASPECT,
            ),
            generate_image(
                back_print_prompt(
                    candidate,
                    blank_color,
                    ink_hint,
                    brand=brand,
                    design_prompt=design_prompt,
                    redo_instructions=redo_instructions,
                ),
                aspect_ratio=FRONT_BACK_ASPECT,
            ),
            generate_image(
                sleeve_print_prompt(
                    company,
                    blank_color,
                    ink_hint,
                    brand=brand,
                    has_logo_ref=has_logo_ref,
                    design_prompt=design_prompt,
                    redo_instructions=redo_instructions,
                ),
                references=refs_or_none,
                aspect_ratio=SQUARE_ASPECT,
            ),
            generate_image(
                neck_print_prompt(
                    company,
                    blank_color,
                    ink_hint,
                    brand=brand,
                    has_logo_ref=has_logo_ref,
                    design_prompt=design_prompt,
                    redo_instructions=redo_instructions,
                ),
                references=refs_or_none,
                aspect_ratio=SQUARE_ASPECT,
            ),
        )
        front_bytes = _transparent_layer(front_raw)
        back_bytes = _transparent_layer(back_raw)
        sleeve_bytes = _transparent_layer(sleeve_raw)
        neck_bytes = _transparent_layer(neck_raw)
        style_refs = [
            reference_from_bytes(front_bytes, "image/png"),
            reference_from_bytes(back_bytes, "image/png"),
        ]
    elif ptype == "hat":
        assert blank_color is not None
        front_prompt = hat_front_prompt(
            company,
            blank_color,
            ink_hint,
            brand=brand,
            has_logo_ref=has_logo_ref,
            design_prompt=design_prompt,
            redo_instructions=redo_instructions,
        )
        front_raw = await generate_image(
            front_prompt,
            references=refs_or_none,
            aspect_ratio=WIDE_PANEL_ASPECT,
        )
        front_bytes = _transparent_layer(front_raw)
        style_refs = [reference_from_bytes(front_bytes, "image/png")]
    else:  # mug
        front_prompt = mug_front_prompt(
            company,
            candidate,
            brand=brand,
            has_logo_ref=has_logo_ref,
            design_prompt=design_prompt,
            redo_instructions=redo_instructions,
        )
        front_raw = await generate_image(
            front_prompt,
            references=refs_or_none,
            aspect_ratio=MUG_WRAP_ASPECT,
        )
        front_bytes = _transparent_layer(front_raw)
        style_refs = [reference_from_bytes(front_bytes, "image/png")]

    mockup_prompt = style_mockup_prompt(
        ptype,
        company,
        candidate,
        blank_color,
        design_prompt=design_prompt,
        redo_instructions=redo_instructions,
    )
    jersey_bytes = await generate_image(
        mockup_prompt,
        references=style_refs,
        aspect_ratio=SQUARE_ASPECT,
    )
    return front_bytes, back_bytes, sleeve_bytes, neck_bytes, jersey_bytes, front_prompt



async def _run_candidate_pipeline(
    *,
    company: str,
    candidate: Candidate,
    ptype: str,
    config: dict,
    brief: str,
    photo_bytes: bytes,
    content_type: str,
    brand: BrandProfile | None,
    logo_bytes: bytes | None,
    has_logo_ref: bool,
    brand_refs: list[dict] | None,
    blank_color: str | None,
    ink_hint: str | None,
    batch_id: str,
    index: int,
    total: int,
) -> dict:
    name = candidate.full_name
    prefix = f"{_slug(company)}_{_slug(name)}_{ptype}_{batch_id}_{index:02d}"
    log.info(
        "candidate %d/%d start name=%r linkedin=%r",
        index,
        total,
        name,
        candidate.linkedin_profile_link,
    )

    front_bytes = back_bytes = sleeve_bytes = neck_bytes = b""
    jersey_bytes = tryon_bytes = b""
    review_history: list[dict] = []
    final_decision = "approve"
    attempts_used = 0
    max_attempts = max_review_attempts()

    redo_instructions: str | None = None
    prior_front: bytes | None = None

    for attempt in range(1, max_attempts + 1):
        attempts_used = attempt
        log.info(
            "candidate %d/%d print + mockup (attempt %d/%d)…",
            index,
            total,
            attempt,
            max_attempts,
        )
        (
            front_bytes,
            back_bytes,
            sleeve_bytes,
            neck_bytes,
            jersey_bytes,
            front_prompt,
        ) = await _generate_print_and_mockup(
            ptype=ptype,
            company=company,
            candidate=name,
            blank_color=blank_color,
            ink_hint=ink_hint,
            brand=brand,
            has_logo_ref=has_logo_ref,
            brand_refs=brand_refs,
            design_prompt=brief,
            redo_instructions=redo_instructions,
            prior_front=prior_front,
        )

        log.info("candidate %d/%d design critic (attempt %d)…", index, total, attempt)
        review: DesignReview = await review_design(
            company_name=company,
            candidate_name=name,
            product_type=ptype,
            blank_color=blank_color,
            design_prompt=brief,
            brand=brand,
            has_logo_ref=has_logo_ref,
            front_png=front_bytes,
            mockup_png=jersey_bytes,
            generation_brief=front_prompt,
            logo_png=logo_bytes,
            attempt=attempt,
        )
        review_history.append(review.to_dict())
        final_decision = review.decision

        if review.decision == "approve":
            log.info(
                "candidate %d/%d approved attempt=%d score=%s",
                index,
                total,
                attempt,
                review.score,
            )
            break

        if attempt >= max_attempts:
            log.info(
                "candidate %d/%d still redo after %d attempts — shipping best effort",
                index,
                total,
                max_attempts,
            )
            break

        redo_instructions = review.redo_instructions
        prior_front = front_bytes

    log.info("candidate %d/%d generating try-on…", index, total)
    tryon_bytes = await generate_image(
        tryon_prompt(ptype, company, name, blank_color),
        references=[
            reference_from_bytes(photo_bytes, content_type),
            reference_from_bytes(jersey_bytes, "image/png"),
        ],
    )

    front_path = OUTPUTS_DIR / f"{prefix}_front.png"
    front_path.write_bytes(front_bytes)
    layer_paths: dict[str, Path] = {"front": front_path}
    if back_bytes:
        layer_paths["back"] = OUTPUTS_DIR / f"{prefix}_back.png"
        layer_paths["back"].write_bytes(back_bytes)
    if sleeve_bytes:
        layer_paths["sleeve"] = OUTPUTS_DIR / f"{prefix}_sleeve.png"
        layer_paths["sleeve"].write_bytes(sleeve_bytes)
    if neck_bytes:
        layer_paths["neck"] = OUTPUTS_DIR / f"{prefix}_neck.png"
        layer_paths["neck"].write_bytes(neck_bytes)

    jersey_path = OUTPUTS_DIR / f"{prefix}_mockup.png"
    tryon_path = OUTPUTS_DIR / f"{prefix}_tryon.png"
    jersey_path.write_bytes(jersey_bytes)
    tryon_path.write_bytes(tryon_bytes)

    images_by_position: dict[str, bytes] = {"front": front_bytes}
    if ptype == "tee":
        images_by_position.update(
            {
                "back": back_bytes,
                "left_sleeve": sleeve_bytes,
                "right_sleeve": sleeve_bytes,
                "neck": neck_bytes,
            }
        )

    printify_info: dict | None = None
    printify_error: str | None = None
    try:
        log.info(
            "candidate %d/%d uploading Printify product=%s color=%s…",
            index,
            total,
            ptype,
            blank_color,
        )
        label = config["label"]
        color_bit = f" ({blank_color})" if blank_color else ""
        printify_info = await upload_and_create_draft(
            images_by_position=images_by_position,
            file_prefix=prefix,
            product_type=ptype,
            blank_color=blank_color,
            title=f"{company} — {name} {label}{color_bit}",
            description=(
                f"Custom {label.lower()} for {name}, branded for {company}. "
                + (
                    f"LinkedIn: {candidate.linkedin_profile_link}. "
                    if candidate.linkedin_profile_link
                    else ""
                )
                + (f"Blank color: {blank_color}. " if blank_color else "")
                + (f"Design brief: {brief}. " if brief else "")
                + "Draft product created by Jersey Studio for future Printify ordering."
            ),
        )
    except PrintifyError as exc:
        log.exception("Printify failed for candidate %r", name)
        printify_error = str(exc)

    layers: dict[str, str | None] = {
        "front_png": to_data_url(front_bytes),
        "front_filename": layer_paths["front"].name,
        "back_png": to_data_url(back_bytes) if back_bytes else None,
        "back_filename": layer_paths["back"].name if "back" in layer_paths else None,
        "sleeve_png": to_data_url(sleeve_bytes) if sleeve_bytes else None,
        "sleeve_filename": layer_paths["sleeve"].name if "sleeve" in layer_paths else None,
        "neck_png": to_data_url(neck_bytes) if neck_bytes else None,
        "neck_filename": layer_paths["neck"].name if "neck" in layer_paths else None,
    }
    latest = review_history[-1] if review_history else None

    return {
        "first_name": candidate.first_name,
        "last_name": candidate.last_name,
        "candidate_name": name,
        "linkedin_profile_link": candidate.linkedin_profile_link,
        "review": {
            "decision": final_decision,
            "attempts": attempts_used,
            "max_attempts": max_attempts,
            "latest": latest,
            "history": review_history,
        },
        "jersey_png": to_data_url(jersey_bytes),
        "tryon_png": to_data_url(tryon_bytes),
        "jersey_filename": jersey_path.name,
        "tryon_filename": tryon_path.name,
        "layers": layers,
        "printify": printify_info,
        "printify_error": printify_error,
    }


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/health")
async def health() -> dict:
    return {
        "ok": True,
        "app": "jersey-studio",
        "product_types": sorted(PRODUCT_TYPES),
    }


@app.post("/generate")
async def generate(
    company_name: str = Form(...),
    photo: UploadFile = File(...),
    candidates_file: UploadFile | None = File(None),
    candidates_text: str = Form(""),
    product_type: str = Form("tee"),
    design_prompt: str = Form(""),
) -> dict:
    company = company_name.strip()
    brief = (design_prompt or "").strip()
    if not company:
        raise HTTPException(status_code=400, detail="Company name is required.")

    text_list = (candidates_text or "").strip()
    file_bytes = b""
    if candidates_file is not None:
        file_bytes = await candidates_file.read()

    try:
        if text_list:
            candidates = parse_candidates_text(text_list)
        elif file_bytes:
            candidates = parse_candidates_file(
                candidates_file.filename if candidates_file else None,
                file_bytes,
            )
        else:
            raise HTTPException(
                status_code=400,
                detail="Provide candidates as free text or upload a CSV/Excel file.",
            )
    except CandidatesFileError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    # Drop accidental CSV header rows that slipped into free-text (e.g. "first_name last_name").
    filtered: list[Candidate] = []
    for person in candidates:
        blob = f"{person.first_name} {person.last_name}".strip().lower()
        if re.search(r"first[_\s:]*name|last[_\s:]*name|^linkedin$", blob):
            log.info("skipping header-like candidate %r", person.full_name)
            continue
        filtered.append(person)
    candidates = filtered
    if not candidates:
        raise HTTPException(
            status_code=400,
            detail="No valid candidates after filtering header rows. Check your CSV/text.",
        )

    ptype = _normalize_product_type(product_type)
    config = get_product_config(ptype)

    photo_bytes = await photo.read()
    if not photo_bytes:
        raise HTTPException(status_code=400, detail="Photo is empty.")

    content_type = (photo.content_type or "image/jpeg").split(";")[0].strip()
    if not content_type.startswith("image/"):
        raise HTTPException(status_code=400, detail="Upload must be an image.")

    batch_id = uuid.uuid4().hex[:10]
    log.info(
        "generate start company=%r candidates=%d product=%s batch=%s brief=%r",
        company,
        len(candidates),
        ptype,
        batch_id,
        brief[:120] if brief else "",
    )

    brand = await lookup_brand(company)
    brand = await enrich_brand_colors(company, brand)
    logo_ref: dict | None = None
    logo_bytes: bytes | None = None
    if brand:
        logo = await download_preferred_logo(brand)
        if logo:
            logo_bytes, logo_media = logo
            logo_ref = reference_from_bytes(logo_bytes, logo_media)
    has_logo_ref = logo_ref is not None
    brand_refs = [logo_ref] if logo_ref else None

    blank_color: str | None = None
    color_reason = ""
    ink_hint: str | None = None
    available_colors: list[str] = []

    try:
        if config["has_color"]:
            log.info("step 0 loading Printify catalog colors + choosing blank color…")
            try:
                available_colors = await list_catalog_colors(
                    blueprint_id=int(config["blueprint_id"]),
                    print_provider_id=int(config["print_provider_id"]),
                )
            except PrintifyError:
                log.exception("catalog color fetch failed; using fallback palette")
                available_colors = sorted(config.get("fallback_colors") or FALLBACK_COLORS)
            log.info("catalog colors available=%d", len(available_colors))

            blank_color, color_reason, ink_hint = await choose_blank_color(
                company,
                available_colors,
                product_label=str(config["label"]).lower(),
                brand=brand,
            )
            log.info(
                "blank color=%r ink=%r reason=%r",
                blank_color,
                ink_hint,
                color_reason,
            )
        else:
            log.info("step 0 mug has no blank color — white ceramic")
            color_reason = "White ceramic mug (no color variants)."

        results: list[dict] = []
        total = len(candidates)
        for index, person in enumerate(candidates, start=1):
            results.append(
                await _run_candidate_pipeline(
                    company=company,
                    candidate=person,
                    ptype=ptype,
                    config=config,
                    brief=brief,
                    photo_bytes=photo_bytes,
                    content_type=content_type,
                    brand=brand,
                    logo_bytes=logo_bytes,
                    has_logo_ref=has_logo_ref,
                    brand_refs=brand_refs,
                    blank_color=blank_color,
                    ink_hint=ink_hint,
                    batch_id=batch_id,
                    index=index,
                    total=total,
                )
            )
    except (OpenRouterImageError, OpenRouterChatError) as exc:
        log.exception("OpenRouter failed")
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    log.info(
        "generate done batch=%s product=%s color=%s candidates=%d",
        batch_id,
        ptype,
        blank_color,
        len(results),
    )

    first = results[0]
    return {
        "product_type": ptype,
        "product_label": config["label"],
        "shirt_color": blank_color,
        "blank_color": blank_color,
        "color_reason": color_reason,
        "catalog_color_count": len(available_colors),
        "design_prompt": brief or None,
        "candidate_count": len(results),
        "brand": (
            {
                "title": brand.title,
                "domain": brand.domain,
                "slogan": brand.slogan,
                "colors": brand.color_hexes,
                "logo_count": len(brand.logo_urls),
                "logo_used": has_logo_ref,
                "source": brand.source,
            }
            if brand
            else None
        ),
        "candidates": results,
        "first_name": first["first_name"],
        "last_name": first["last_name"],
        "candidate_name": first["candidate_name"],
        "linkedin_profile_link": first["linkedin_profile_link"],
        "review": first["review"],
        "jersey_png": first["jersey_png"],
        "tryon_png": first["tryon_png"],
        "jersey_filename": first["jersey_filename"],
        "tryon_filename": first["tryon_filename"],
        "layers": first["layers"],
        "printify": first["printify"],
        "printify_error": first["printify_error"],
    }

