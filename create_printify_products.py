#!/usr/bin/env python3
"""Create a t-shirt (image + text on front, text on back) and a mug (image + text)
on Printify.

The Printify API cannot create native text layers (font_* fields are read-only),
so text is rendered to a transparent PNG with Pillow and placed as an image layer.

Usage:
    python3 create_printify_products.py

Requires PRINTIFY_API_KEY in .env (same directory) or the environment.
"""

import base64
import io
import os
import sys

import requests
from PIL import Image, ImageDraw, ImageFont

# ----------------------------------------------------------------------------
# Config — edit these
# ----------------------------------------------------------------------------
IMAGE_URL = "https://picsum.photos/1200/1200.jpg"  # image for the front (or set IMAGE_FILE)
IMAGE_FILE = None                                   # local path; takes precedence over IMAGE_URL

FRONT_TEXT = "HELLO HACKATHON"
BACK_TEXT = "TEAM SHOP SWAP"
TEXT_COLOR = (255, 40, 40, 255)                     # RGBA
FONT_PATH = "/System/Library/Fonts/Supplemental/Arial Bold.ttf"

SHIRT_TITLE = "Hackathon Tee"
SHIRT_DESCRIPTION = "Custom tee with image + text, created via the Printify API."
SHIRT_PRICE_CENTS = 2500

MUG_TITLE = "Hackathon Mug"
MUG_DESCRIPTION = "Custom mug with image + text, created via the Printify API."
MUG_PRICE_CENTS = 1500

# Catalog choices (verified 2026-07):
# Shirt: Bella+Canvas 3001 (blueprint 12) via SwiftPOD (provider 39)
#   - placeholders: front, back, sleeves, neck; front/back area 3356x4364 px
# Mug: Ceramic Mug 11oz/15oz (blueprint 478) via SwiftPOD (provider 39)
#   - single wraparound "front" area, 2475x1155 px (11oz)
SHIRT_BLUEPRINT_ID = 12
MUG_BLUEPRINT_ID = 478
PRINT_PROVIDER_ID = 39
SHIRT_COLORS = {"Black", "White"}  # variant colors to enable (all sizes)

BASE_URL = "https://api.printify.com/v1"


# ----------------------------------------------------------------------------
# API helpers
# ----------------------------------------------------------------------------
def load_api_key():
    if os.environ.get("PRINTIFY_API_KEY"):
        return os.environ["PRINTIFY_API_KEY"]
    env_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")
    if os.path.exists(env_path):
        for line in open(env_path):
            line = line.strip()
            if line.startswith("PRINTIFY_API_KEY="):
                return line.split("=", 1)[1].strip().strip('"')
    sys.exit("PRINTIFY_API_KEY not found in environment or .env")


SESSION = requests.Session()
SESSION.headers.update({
    "Authorization": f"Bearer {load_api_key()}",
    "User-Agent": "hackathon-printify-script",
})


def api(method, path, **kwargs):
    resp = SESSION.request(method, f"{BASE_URL}{path}", **kwargs)
    if not resp.ok:
        sys.exit(f"{method} {path} failed ({resp.status_code}): {resp.text}")
    return resp.json()


# ----------------------------------------------------------------------------
# Steps
# ----------------------------------------------------------------------------
def get_shop_id():
    shops = api("GET", "/shops.json")
    if not shops:
        sys.exit("No shops on this Printify account.")
    return shops[0]["id"]


def upload_main_image():
    if IMAGE_FILE:
        contents = base64.b64encode(open(IMAGE_FILE, "rb").read()).decode()
        body = {"file_name": os.path.basename(IMAGE_FILE), "contents": contents}
    else:
        body = {"file_name": "front-image.png", "url": IMAGE_URL}
    up = api("POST", "/uploads/images.json", json=body)
    print(f"  uploaded image: {up['id']} ({up['width']}x{up['height']})")
    return up["id"]


def upload_text_image(text):
    """Render text to a transparent PNG and upload it."""
    font = ImageFont.truetype(FONT_PATH, 300)
    left, top, right, bottom = font.getbbox(text)
    img = Image.new("RGBA", (right - left + 80, bottom - top + 80), (0, 0, 0, 0))
    ImageDraw.Draw(img).text((40 - left, 40 - top), text, font=font, fill=TEXT_COLOR)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    body = {
        "file_name": "text.png",
        "contents": base64.b64encode(buf.getvalue()).decode(),
    }
    up = api("POST", "/uploads/images.json", json=body)
    print(f"  uploaded text layer '{text}': {up['id']}")
    return up["id"]


def enabled_shirt_variants(shop_note=""):
    """All size variants of the chosen colors for the shirt blueprint."""
    data = api(
        "GET",
        f"/catalog/blueprints/{SHIRT_BLUEPRINT_ID}/print_providers/{PRINT_PROVIDER_ID}/variants.json",
    )
    ids = [v["id"] for v in data["variants"] if v["options"].get("color") in SHIRT_COLORS]
    if not ids:
        sys.exit(f"No shirt variants matched colors {SHIRT_COLORS}")
    return ids


def mug_variants():
    data = api(
        "GET",
        f"/catalog/blueprints/{MUG_BLUEPRINT_ID}/print_providers/{PRINT_PROVIDER_ID}/variants.json",
    )
    return [v["id"] for v in data["variants"]]


def create_product(shop_id, body):
    product = api("POST", f"/shops/{shop_id}/products.json", json=body)
    front = next(
        (i["src"] for i in product["images"] if i.get("position") == "front"),
        product["images"][0]["src"] if product["images"] else "no mockup",
    )
    print(f"  created '{product['title']}' (id {product['id']})")
    print(f"  mockup: {front}")
    return product


def main():
    shop_id = get_shop_id()
    print(f"shop: {shop_id}")

    print("uploading artwork...")
    image_id = upload_main_image()
    front_text_id = upload_text_image(FRONT_TEXT)
    back_text_id = upload_text_image(BACK_TEXT)

    print("creating shirt...")
    shirt_variant_ids = enabled_shirt_variants()
    create_product(shop_id, {
        "title": SHIRT_TITLE,
        "description": SHIRT_DESCRIPTION,
        "blueprint_id": SHIRT_BLUEPRINT_ID,
        "print_provider_id": PRINT_PROVIDER_ID,
        "variants": [
            {"id": v, "price": SHIRT_PRICE_CENTS, "is_enabled": True}
            for v in shirt_variant_ids
        ],
        "print_areas": [{
            "variant_ids": shirt_variant_ids,
            "placeholders": [
                {
                    "position": "front",
                    "images": [
                        # x/y are the layer center as a fraction of the print
                        # area; scale is relative to the area width
                        {"id": image_id, "x": 0.5, "y": 0.4, "scale": 0.85, "angle": 0},
                        {"id": front_text_id, "x": 0.5, "y": 0.8, "scale": 0.9, "angle": 0},
                    ],
                },
                {
                    "position": "back",
                    "images": [
                        {"id": back_text_id, "x": 0.5, "y": 0.3, "scale": 0.9, "angle": 0},
                    ],
                },
            ],
        }],
    })

    print("creating mug...")
    mug_variant_ids = mug_variants()
    create_product(shop_id, {
        "title": MUG_TITLE,
        "description": MUG_DESCRIPTION,
        "blueprint_id": MUG_BLUEPRINT_ID,
        "print_provider_id": PRINT_PROVIDER_ID,
        "variants": [
            {"id": v, "price": MUG_PRICE_CENTS, "is_enabled": True}
            for v in mug_variant_ids
        ],
        "print_areas": [{
            "variant_ids": mug_variant_ids,
            "placeholders": [{
                "position": "front",  # single wraparound area on mugs
                "images": [
                    {"id": image_id, "x": 0.28, "y": 0.5, "scale": 0.32, "angle": 0},
                    {"id": front_text_id, "x": 0.72, "y": 0.5, "scale": 0.38, "angle": 0},
                ],
            }],
        }],
    })

    print("done — products are drafts in your Printify shop (not published).")


if __name__ == "__main__":
    main()
