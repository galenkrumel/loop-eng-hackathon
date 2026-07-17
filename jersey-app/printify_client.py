"""Printify API client: upload artwork and create draft products."""

from __future__ import annotations

import base64
import hashlib
import os
from typing import Any

import httpx

PRINTIFY_BASE = "https://api.printify.com/v1"
USER_AGENT = "JerseyDesignApp/1.0"

# Bella+Canvas 3001 Unisex Jersey Short Sleeve Tee via Printify Choice
DEFAULT_BLUEPRINT_ID = 12
DEFAULT_PRINT_PROVIDER_ID = 99
# Kept only as a last-resort fallback if catalog fetch fails.
FALLBACK_COLORS = frozenset({"Black", "White", "Navy", "True Royal", "Red"})
DEFAULT_COLORS = FALLBACK_COLORS  # backwards-compatible alias
DEFAULT_SIZES = frozenset({"S", "M", "L", "XL", "2XL"})
DEFAULT_PRICE_CENTS = 2499  # $24.99 retail placeholder

# Preferred print positions in display / generation order (tee default).
PREFERRED_POSITIONS = (
    "front",
    "back",
    "left_sleeve",
    "right_sleeve",
    "neck",
)

# Product catalog: tee (jersey), hat (DTF front), mug (sublimation wrap).
PRODUCT_TYPES: dict[str, dict[str, Any]] = {
    "tee": {
        "label": "T-shirt",
        "blueprint_id": 12,
        "print_provider_id": 99,
        "preferred_positions": (
            "front",
            "back",
            "left_sleeve",
            "right_sleeve",
            "neck",
        ),
        "has_color": True,
        "sizes": frozenset({"S", "M", "L", "XL", "2XL"}),
        "price_cents": 2499,
        "fallback_colors": FALLBACK_COLORS,
    },
    "hat": {
        "label": "Hat",
        # OTTO Cap Low Profile Baseball Cap — DTF front via Printify Choice
        "blueprint_id": 1108,
        "print_provider_id": 99,
        "preferred_positions": ("front",),
        "has_color": True,
        "sizes": frozenset({"One size"}),
        "price_cents": 2499,
        "fallback_colors": frozenset(
            {"Black", "Dark Green", "Dark Navy", "Khaki", "Red", "Royal", "White"}
        ),
    },
    "mug": {
        "label": "Mug",
        # Ceramic Mug 11oz/15oz — dye-sublimation front wrap
        "blueprint_id": 478,
        "print_provider_id": 99,
        "preferred_positions": ("front",),
        "has_color": False,
        "sizes": frozenset({"11oz", "15oz"}),
        "price_cents": 1999,
        "fallback_colors": frozenset(),
    },
}


class PrintifyError(RuntimeError):
    """Raised when a Printify API call fails."""


def get_product_config(product_type: str) -> dict[str, Any]:
    key = (product_type or "tee").strip().lower()
    if key not in PRODUCT_TYPES:
        raise PrintifyError(
            f"Unknown product_type {product_type!r}. "
            f"Choose one of: {', '.join(sorted(PRODUCT_TYPES))}."
        )
    return PRODUCT_TYPES[key]


def _token() -> str:
    token = os.getenv("PRINTIFY_API_TOKEN", "").strip()
    if not token:
        raise PrintifyError(
            "PRINTIFY_API_TOKEN is not set. Add it to jersey-app/.env"
        )
    return token


def _headers() -> dict[str, str]:
    return {
        "Authorization": f"Bearer {_token()}",
        "User-Agent": USER_AGENT,
        "Content-Type": "application/json",
    }


def resolve_print_provider_id(default: int = DEFAULT_PRINT_PROVIDER_ID) -> int:
    configured = os.getenv("PRINTIFY_PRINT_PROVIDER_ID", "").strip()
    if configured:
        return int(configured)
    return default


async def _request(
    method: str,
    path: str,
    *,
    json: dict[str, Any] | None = None,
    timeout: float = 60.0,
) -> Any:
    url = f"{PRINTIFY_BASE}{path}"
    async with httpx.AsyncClient(timeout=timeout) as client:
        response = await client.request(
            method, url, headers=_headers(), json=json
        )

    try:
        payload = response.json()
    except Exception:
        payload = {"raw": response.text[:800]}

    if response.status_code >= 400:
        raise PrintifyError(
            f"Printify {method} {path} failed ({response.status_code}): {payload}"
        )
    return payload


async def list_shops() -> list[dict[str, Any]]:
    data = await _request("GET", "/shops.json")
    if not isinstance(data, list):
        raise PrintifyError(f"Unexpected shops response: {data}")
    return data


async def resolve_shop_id() -> int:
    configured = os.getenv("PRINTIFY_SHOP_ID", "").strip()
    if configured:
        return int(configured)
    shops = await list_shops()
    if not shops:
        raise PrintifyError("No Printify shops found on this account.")
    return int(shops[0]["id"])


async def upload_image(file_name: str, image_bytes: bytes) -> dict[str, Any]:
    """Upload PNG/JPEG artwork; returns upload object including id."""
    payload = {
        "file_name": file_name,
        "contents": base64.b64encode(image_bytes).decode("ascii"),
    }
    data = await _request("POST", "/uploads/images.json", json=payload, timeout=120.0)
    if not isinstance(data, dict) or "id" not in data:
        raise PrintifyError(f"Unexpected upload response: {data}")
    return data


async def fetch_variants(
    blueprint_id: int = DEFAULT_BLUEPRINT_ID,
    print_provider_id: int | None = None,
) -> list[dict[str, Any]]:
    provider = (
        print_provider_id
        if print_provider_id is not None
        else resolve_print_provider_id()
    )
    data = await _request(
        "GET",
        f"/catalog/blueprints/{blueprint_id}/print_providers/{provider}/variants.json",
        timeout=90.0,
    )
    variants = data.get("variants") if isinstance(data, dict) else None
    if not isinstance(variants, list):
        raise PrintifyError(f"Unexpected variants response: {data}")
    return variants


def catalog_colors(variants: list[dict[str, Any]]) -> list[str]:
    """Unique blank colors available on this blueprint/provider (sorted)."""
    colors: list[str] = []
    seen: set[str] = set()
    for variant in variants:
        color = variant.get("options", {}).get("color")
        if isinstance(color, str) and color and color not in seen:
            seen.add(color)
            colors.append(color)
    return sorted(colors)


async def list_catalog_colors(
    blueprint_id: int = DEFAULT_BLUEPRINT_ID,
    print_provider_id: int | None = None,
) -> list[str]:
    """Fetch every blank color Printify offers for this blueprint/provider."""
    variants = await fetch_variants(blueprint_id, print_provider_id)
    colors = catalog_colors(variants)
    if not colors:
        raise PrintifyError("No colors found in Printify catalog for this blueprint.")
    return colors


def resolve_shirt_color(
    requested: str | None,
    *,
    allowed: frozenset[str] | set[str] | list[str] | None = None,
) -> str:
    """Map a requested color onto an allowed Printify color name."""
    palette = set(allowed) if allowed is not None else set(FALLBACK_COLORS)
    if not palette:
        raise PrintifyError("No shirt colors available for this blueprint.")
    if requested:
        exact = next((c for c in palette if c.lower() == requested.strip().lower()), None)
        if exact:
            return exact
        # Soft match: prefer longest catalog name contained in / containing the request.
        soft_matches = [
            c
            for c in palette
            if c.lower() in requested.lower() or requested.lower() in c.lower()
        ]
        if soft_matches:
            return max(soft_matches, key=len)
    # Stable default if the model returns something unknown.
    for preferred in ("Black", "Navy", "White", "Dark Navy", "Royal"):
        if preferred in palette:
            return preferred
    return sorted(palette)[0]


def _select_variants(
    variants: list[dict[str, Any]],
    *,
    colors: frozenset[str] | set[str] | None = None,
    sizes: frozenset[str] | set[str] | None = None,
    require_color: bool = True,
) -> list[dict[str, Any]]:
    color_set = set(colors) if colors is not None else None
    size_set = set(sizes) if sizes is not None else set(DEFAULT_SIZES)
    selected = []
    for v in variants:
        opts = v.get("options") or {}
        size = opts.get("size")
        color = opts.get("color")
        if size_set and size not in size_set:
            # Some products only have size; others only color — if size key missing, allow.
            if "size" in opts:
                continue
        if require_color and color_set is not None:
            if color not in color_set:
                continue
        selected.append(v)

    if not selected and colors is not None and require_color:
        # Color was forced but sizes mismatched — keep the color, any size.
        selected = [
            v
            for v in variants
            if v.get("options", {}).get("color") in color_set
        ][:20]
    if not selected and not require_color:
        # Size-only products (e.g. mugs): take matching sizes or all.
        selected = [
            v
            for v in variants
            if not size_set or v.get("options", {}).get("size") in size_set
            or "size" not in (v.get("options") or {})
        ]
    if not selected:
        selected = variants[:20]
    if not selected:
        raise PrintifyError("No Printify variants available for this blueprint.")
    return selected


def available_positions(variants: list[dict[str, Any]]) -> set[str]:
    """Positions supported by every selected variant (intersection)."""
    position_sets: list[set[str]] = []
    for variant in variants:
        placeholders = variant.get("placeholders") or []
        positions = {
            str(ph["position"])
            for ph in placeholders
            if isinstance(ph, dict) and ph.get("position")
        }
        if positions:
            position_sets.append(positions)
    if not position_sets:
        return set()
    shared = set.intersection(*position_sets)
    return shared


def placeholder_sizes(
    variants: list[dict[str, Any]],
) -> dict[str, tuple[int, int]]:
    """Representative (width, height) per position from the first selected variant."""
    sizes: dict[str, tuple[int, int]] = {}
    for variant in variants:
        for ph in variant.get("placeholders") or []:
            if not isinstance(ph, dict):
                continue
            position = ph.get("position")
            width = ph.get("width")
            height = ph.get("height")
            if (
                position
                and isinstance(width, int)
                and isinstance(height, int)
                and position not in sizes
            ):
                sizes[str(position)] = (width, height)
        if sizes:
            break
    return sizes


def _centered_image(image_id: str) -> dict[str, Any]:
    return {
        "id": image_id,
        "x": 0.5,
        "y": 0.5,
        "scale": 1,
        "angle": 0,
    }


def _mockup_urls(product: dict[str, Any]) -> list[dict[str, Any]]:
    images = product.get("images") or []
    out: list[dict[str, Any]] = []
    if not isinstance(images, list):
        return out
    for img in images:
        if not isinstance(img, dict) or not img.get("src"):
            continue
        out.append(
            {
                "src": img["src"],
                "position": img.get("position"),
                "is_default": bool(img.get("is_default")),
            }
        )
    return out


async def create_product(
    *,
    title: str,
    description: str,
    images_by_position: dict[str, str],
    product_type: str = "tee",
    blank_color: str | None = None,
    shop_id: int | None = None,
    price_cents: int | None = None,
) -> dict[str, Any]:
    """Create a draft Printify product for tee, hat, or mug."""
    if not images_by_position:
        raise PrintifyError("At least one print-position image id is required.")

    config = get_product_config(product_type)
    blueprint_id = int(config["blueprint_id"])
    provider = int(config["print_provider_id"])
    env_provider = os.getenv("PRINTIFY_PRINT_PROVIDER_ID", "").strip()
    if env_provider and product_type == "tee":
        # Tee keeps optional env override; hat/mug use fixed working providers.
        provider = int(env_provider)

    preferred_positions: tuple[str, ...] = tuple(config["preferred_positions"])
    has_color = bool(config["has_color"])
    size_set = set(config["sizes"])
    retail = int(price_cents if price_cents is not None else config["price_cents"])

    sid = shop_id if shop_id is not None else await resolve_shop_id()
    all_variants = await fetch_variants(blueprint_id, provider)

    chosen_color: str | None = None
    if has_color:
        allowed_colors = set(catalog_colors(all_variants)) or set(
            config.get("fallback_colors") or FALLBACK_COLORS
        )
        chosen_color = resolve_shirt_color(blank_color, allowed=allowed_colors)
        variants = _select_variants(
            all_variants,
            colors={chosen_color},
            sizes=size_set,
            require_color=True,
        )
    else:
        variants = _select_variants(
            all_variants,
            colors=None,
            sizes=size_set,
            require_color=False,
        )

    variant_ids = [int(v["id"]) for v in variants]
    supported = available_positions(variants)

    placeholders: list[dict[str, Any]] = []
    used_positions: list[str] = []
    for position in preferred_positions:
        image_id = images_by_position.get(position)
        if not image_id or position not in supported:
            continue
        placeholders.append(
            {
                "position": position,
                "images": [_centered_image(image_id)],
            }
        )
        used_positions.append(position)

    for position, image_id in images_by_position.items():
        if position in used_positions or position not in supported:
            continue
        # Skip embroidery-only positions unless explicitly preferred.
        if "embroidery" in position and position not in preferred_positions:
            continue
        placeholders.append(
            {
                "position": position,
                "images": [_centered_image(image_id)],
            }
        )
        used_positions.append(position)

    if not placeholders:
        raise PrintifyError(
            "None of the provided print positions are supported by this "
            f"provider (supported={sorted(supported)}, "
            f"provided={sorted(images_by_position)})."
        )

    product_payload = {
        "title": title[:200],
        "description": description[:2000],
        "blueprint_id": blueprint_id,
        "print_provider_id": provider,
        "variants": [
            {"id": vid, "price": retail, "is_enabled": True}
            for vid in variant_ids
        ],
        "print_areas": [
            {
                "variant_ids": variant_ids,
                "placeholders": placeholders,
            }
        ],
    }

    product = await _request(
        "POST",
        f"/shops/{sid}/products.json",
        json=product_payload,
        timeout=120.0,
    )
    if not isinstance(product, dict) or "id" not in product:
        raise PrintifyError(f"Unexpected product response: {product}")

    product_id = product["id"]
    return {
        "shop_id": sid,
        "product_id": product_id,
        "title": product.get("title", title),
        "product_type": product_type,
        "blueprint_id": blueprint_id,
        "print_provider_id": provider,
        "shirt_color": chosen_color,
        "blank_color": chosen_color,
        "variant_count": len(variant_ids),
        "positions": used_positions,
        "placeholder_sizes": {
            pos: {"width": wh[0], "height": wh[1]}
            for pos, wh in placeholder_sizes(variants).items()
            if pos in used_positions
        },
        "mockups": _mockup_urls(product),
        "dashboard_url": f"https://printify.com/app/product-details/{product_id}",
        "status": "draft",
    }


# Backwards-compatible alias
async def create_jersey_product(
    *,
    title: str,
    description: str,
    images_by_position: dict[str, str],
    shirt_color: str | None = None,
    shop_id: int | None = None,
    blueprint_id: int = DEFAULT_BLUEPRINT_ID,
    print_provider_id: int | None = None,
    price_cents: int = DEFAULT_PRICE_CENTS,
) -> dict[str, Any]:
    _ = blueprint_id, print_provider_id  # legacy kwargs ignored; tee config wins
    return await create_product(
        title=title,
        description=description,
        images_by_position=images_by_position,
        product_type="tee",
        blank_color=shirt_color,
        shop_id=shop_id,
        price_cents=price_cents,
    )


async def upload_and_create_draft(
    *,
    images_by_position: dict[str, bytes],
    file_prefix: str,
    title: str,
    description: str,
    shirt_color: str | None = None,
    blank_color: str | None = None,
    product_type: str = "tee",
) -> dict[str, Any]:
    """Upload print-ready layers then create a Printify draft."""
    if not images_by_position:
        raise PrintifyError("images_by_position must not be empty.")

    color = blank_color if blank_color is not None else shirt_color

    # Deduplicate uploads when left/right sleeve share the same artwork bytes.
    hash_to_upload_id: dict[str, str] = {}
    position_to_upload_id: dict[str, str] = {}
    upload_ids: list[str] = []

    for position, image_bytes in images_by_position.items():
        digest = hashlib.sha256(image_bytes).hexdigest()
        if digest not in hash_to_upload_id:
            upload = await upload_image(
                f"{file_prefix}_{position}.png",
                image_bytes,
            )
            upload_id = str(upload["id"])
            hash_to_upload_id[digest] = upload_id
            upload_ids.append(upload_id)
        position_to_upload_id[position] = hash_to_upload_id[digest]

    product = await create_product(
        title=title,
        description=description,
        images_by_position=position_to_upload_id,
        product_type=product_type,
        blank_color=color,
    )
    product["upload_ids"] = upload_ids
    product["uploads_by_position"] = position_to_upload_id
    return product
