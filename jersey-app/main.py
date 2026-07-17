"""Jersey design + try-on app."""

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

from openrouter_chat import OpenRouterChatError, chat_json
from openrouter_images import (
    OpenRouterImageError,
    generate_image,
    reference_from_bytes,
    to_data_url,
)
from printify_client import (
    FALLBACK_COLORS,
    PrintifyError,
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

# Aspect ratios matched to Printify Choice Bella+Canvas 3001 placeholders (~3:4 front/back).
FRONT_BACK_ASPECT = "3:4"
SQUARE_ASPECT = "1:1"

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


def _shirt_is_dark(shirt_color: str, ink_hint: str | None = None) -> bool:
    if ink_hint in {"light", "light_ink", "white_ink"}:
        return True
    if ink_hint in {"dark", "dark_ink", "black_ink"}:
        return False
    lower = shirt_color.lower()
    return any(hint in lower for hint in _DARK_NAME_HINTS)


def _ink_guidance(shirt_color: str, ink_hint: str | None = None) -> str:
    if _shirt_is_dark(shirt_color, ink_hint):
        return (
            f"The blank tee is {shirt_color} (dark / saturated). Use light / high-contrast ink "
            f"(white, cream, bright accents) so the print reads clearly on {shirt_color}."
        )
    return (
        f"The blank tee is {shirt_color} (light / pale). Use dark / high-contrast ink "
        f"(black, navy, deep brand colors) so the print reads clearly on {shirt_color}."
    )


def _print_art_rules(shirt_color: str, ink_hint: str | None = None) -> str:
    return (
        "CRITICAL BACKGROUND: output a PNG with a TRUE transparent alpha channel. "
        "If the model cannot emit alpha, fill ONLY the empty backdrop with a flat solid "
        "chroma-key color #00FF00 (pure green) and put NOTHING else on that green — no "
        "gradients, no checkerboard, no paper texture, no white matte. "
        "Print-ready flat graphic only: no shirt silhouette, no fabric photo, no garment "
        "mockup, no hanger, no 3D product shot, no shadows under a tee, no white or colored "
        "rectangle behind the art. Sharp high-contrast vector-like artwork suitable for DTG. "
        f"{_ink_guidance(shirt_color, ink_hint)} "
        "Centered composition, no watermark, no extra people or scenery."
    )


def front_print_prompt(
    company_name: str, shirt_color: str, ink_hint: str | None = None
) -> str:
    return (
        f'Create a front-chest print graphic for the company "{company_name}" that will be '
        f"printed on a {shirt_color} Bella+Canvas 3001 tee. Infer a cohesive brand crest or "
        f"wordmark (colors, typography, motifs) from the company name. Athletic sports-jersey "
        f"style emblem for the center chest. {_print_art_rules(shirt_color, ink_hint)}"
    )


def back_print_prompt(
    candidate_name: str, shirt_color: str, ink_hint: str | None = None
) -> str:
    return (
        f'Create a back-of-jersey name print: the player name "{candidate_name}" in large '
        f"classic athletic block lettering (bold, arched or straight). Designed for a "
        f"{shirt_color} tee — letters must contrast strongly with {shirt_color}. "
        f"No shirt body, no number required unless it fits cleanly under the name. "
        f"{_print_art_rules(shirt_color, ink_hint)}"
    )


def sleeve_print_prompt(
    company_name: str, shirt_color: str, ink_hint: str | None = None
) -> str:
    return (
        f'Create a small square sleeve print mark for "{company_name}" on a {shirt_color} tee: '
        f"a simplified crest, monogram, or logo that reads clearly at sleeve size. Keep it "
        f"minimal. {_print_art_rules(shirt_color, ink_hint)}"
    )


def neck_print_prompt(
    company_name: str, shirt_color: str, ink_hint: str | None = None
) -> str:
    return (
        f'Create a small inside-neck label graphic for "{company_name}" on a {shirt_color} tee: '
        f"compact wordmark or logo sized for a neck tag, clean and legible at small print size. "
        f"{_print_art_rules(shirt_color, ink_hint)}"
    )


def style_mockup_prompt(
    company_name: str, candidate_name: str, shirt_color: str
) -> str:
    return (
        f'Create a photorealistic sports jersey / t-shirt product mockup for "{company_name}" '
        f'with the player name "{candidate_name}". The blank garment MUST be a {shirt_color} '
        f"short-sleeve tee (exact shirt color: {shirt_color}), not white unless the color is "
        f"White. Use the reference images as the exact print artwork: place the front crest on "
        f"the chest and imagine the name print on the back. Front-view flat or lightly worn "
        f"jersey on a clean neutral background, athletic cut, sharp readable branding, no "
        f"watermark, no extra people."
    )


def tryon_prompt(company_name: str, candidate_name: str, shirt_color: str) -> str:
    return (
        f"Using the reference photos: keep the exact likeness, face, hair, and body of the "
        f"person in the first reference image. Dress them in the sports jersey from the "
        f"second reference image (the {shirt_color} {company_name} jersey with the name "
        f'"{candidate_name}"). Keep the shirt color as {shirt_color}. Natural standing or '
        f"three-quarter portrait, realistic fabric fit and folds, consistent lighting, "
        f"photorealistic. Do not change the person's identity. Clean background. No watermark."
    )


async def choose_shirt_color(
    company_name: str,
    available_colors: list[str],
) -> tuple[str, str, str]:
    """Pick a Printify blank color from the full catalog.

    Returns (color, reason, ink_hint) where ink_hint is 'light' (light ink on dark
    shirts) or 'dark' (dark ink on light shirts).
    """
    colors = available_colors or sorted(FALLBACK_COLORS)
    choices = ", ".join(colors)
    data = await chat_json(
        system=(
            "You are a merch art director. Choose exactly one t-shirt blank color from the "
            "allowed Printify catalog list (copy the string EXACTLY). Prefer a color that "
            "fits the brand and gives strong contrast for jersey-style prints. Also say "
            "whether print ink should be light (for dark/saturated blanks) or dark (for "
            "light/pale blanks). Respond with JSON only."
        ),
        user=(
            f'Company / brand name: "{company_name}"\n'
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


def _transparent_layer(image_bytes: bytes) -> bytes:
    return ensure_transparent_background(image_bytes)


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/health")
async def health() -> dict:
    return {"ok": True, "app": "jersey-studio"}


@app.post("/generate")
async def generate(
    company_name: str = Form(...),
    candidate_name: str = Form(...),
    photo: UploadFile = File(...),
) -> dict:
    company = company_name.strip()
    candidate = candidate_name.strip()
    if not company or not candidate:
        raise HTTPException(status_code=400, detail="Company and candidate names are required.")

    photo_bytes = await photo.read()
    if not photo_bytes:
        raise HTTPException(status_code=400, detail="Photo is empty.")

    content_type = (photo.content_type or "image/jpeg").split(";")[0].strip()
    if not content_type.startswith("image/"):
        raise HTTPException(status_code=400, detail="Upload must be an image.")

    run_id = uuid.uuid4().hex[:10]
    prefix = f"{_slug(company)}_{_slug(candidate)}_{run_id}"
    log.info("generate start company=%r candidate=%r run=%s", company, candidate, run_id)

    try:
        log.info("step 0/5 loading Printify catalog colors + choosing shirt color…")
        try:
            available_colors = await list_catalog_colors()
        except PrintifyError:
            log.exception("catalog color fetch failed; using fallback palette")
            available_colors = sorted(FALLBACK_COLORS)
        log.info("catalog colors available=%d", len(available_colors))

        shirt_color, color_reason, ink_hint = await choose_shirt_color(
            company, available_colors
        )
        log.info(
            "shirt color=%r ink=%r reason=%r",
            shirt_color,
            ink_hint,
            color_reason,
        )

        log.info("step 1/5 generating print-ready layers (front, back, sleeve, neck)…")
        front_raw, back_raw, sleeve_raw, neck_raw = await asyncio.gather(
            generate_image(
                front_print_prompt(company, shirt_color, ink_hint),
                aspect_ratio=FRONT_BACK_ASPECT,
            ),
            generate_image(
                back_print_prompt(candidate, shirt_color, ink_hint),
                aspect_ratio=FRONT_BACK_ASPECT,
            ),
            generate_image(
                sleeve_print_prompt(company, shirt_color, ink_hint),
                aspect_ratio=SQUARE_ASPECT,
            ),
            generate_image(
                neck_print_prompt(company, shirt_color, ink_hint),
                aspect_ratio=SQUARE_ASPECT,
            ),
        )
        front_bytes = _transparent_layer(front_raw)
        back_bytes = _transparent_layer(back_raw)
        sleeve_bytes = _transparent_layer(sleeve_raw)
        neck_bytes = _transparent_layer(neck_raw)

        log.info("step 2/5 generating style mockup for UI / try-on…")
        jersey_bytes = await generate_image(
            style_mockup_prompt(company, candidate, shirt_color),
            references=[
                reference_from_bytes(front_bytes, "image/png"),
                reference_from_bytes(back_bytes, "image/png"),
            ],
            aspect_ratio=SQUARE_ASPECT,
        )

        log.info("step 3/5 generating try-on…")
        tryon_bytes = await generate_image(
            tryon_prompt(company, candidate, shirt_color),
            references=[
                reference_from_bytes(photo_bytes, content_type),
                reference_from_bytes(jersey_bytes, "image/png"),
            ],
        )
    except (OpenRouterImageError, OpenRouterChatError) as exc:
        log.exception("OpenRouter failed")
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    layer_paths = {
        "front": OUTPUTS_DIR / f"{prefix}_front.png",
        "back": OUTPUTS_DIR / f"{prefix}_back.png",
        "sleeve": OUTPUTS_DIR / f"{prefix}_sleeve.png",
        "neck": OUTPUTS_DIR / f"{prefix}_neck.png",
    }
    layer_paths["front"].write_bytes(front_bytes)
    layer_paths["back"].write_bytes(back_bytes)
    layer_paths["sleeve"].write_bytes(sleeve_bytes)
    layer_paths["neck"].write_bytes(neck_bytes)

    jersey_path = OUTPUTS_DIR / f"{prefix}_jersey.png"
    tryon_path = OUTPUTS_DIR / f"{prefix}_tryon.png"
    jersey_path.write_bytes(jersey_bytes)
    tryon_path.write_bytes(tryon_bytes)

    images_by_position = {
        "front": front_bytes,
        "back": back_bytes,
        "left_sleeve": sleeve_bytes,
        "right_sleeve": sleeve_bytes,
        "neck": neck_bytes,
    }

    printify_info: dict | None = None
    printify_error: str | None = None
    try:
        log.info("step 4/5 uploading print layers to Printify (color=%s)…", shirt_color)
        printify_info = await upload_and_create_draft(
            images_by_position=images_by_position,
            file_prefix=prefix,
            shirt_color=shirt_color,
            title=f"{company} — {candidate} Jersey ({shirt_color})",
            description=(
                f"Custom jersey tee for {candidate}, branded for {company}. "
                f"Blank color: {shirt_color}. "
                "Print-ready front, back, sleeve, and neck artwork. "
                "Draft product created by Jersey Studio for future Printify ordering."
            ),
        )
        log.info(
            "Printify product %s color=%s positions=%s",
            printify_info.get("product_id"),
            printify_info.get("shirt_color"),
            printify_info.get("positions"),
        )
    except PrintifyError as exc:
        # Images still succeed even if Printify is down — surface the error separately.
        log.exception("Printify failed")
        printify_error = str(exc)

    log.info("generate done run=%s color=%s", run_id, shirt_color)
    return {
        "shirt_color": shirt_color,
        "color_reason": color_reason,
        "catalog_color_count": len(available_colors),
        "jersey_png": to_data_url(jersey_bytes),
        "tryon_png": to_data_url(tryon_bytes),
        "jersey_filename": jersey_path.name,
        "tryon_filename": tryon_path.name,
        "layers": {
            "front_png": to_data_url(front_bytes),
            "back_png": to_data_url(back_bytes),
            "sleeve_png": to_data_url(sleeve_bytes),
            "neck_png": to_data_url(neck_bytes),
            "front_filename": layer_paths["front"].name,
            "back_filename": layer_paths["back"].name,
            "sleeve_filename": layer_paths["sleeve"].name,
            "neck_filename": layer_paths["neck"].name,
        },
        "printify": printify_info,
        "printify_error": printify_error,
    }
