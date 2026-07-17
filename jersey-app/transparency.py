"""Ensure print-layer PNGs have a real alpha background."""

from __future__ import annotations

from io import BytesIO

from PIL import Image


def ensure_transparent_background(image_bytes: bytes, *, tolerance: int = 42) -> bytes:
    """
    Force a transparent background for print-ready artwork.

    gpt-image-2 cannot emit alpha, so we remove near-uniform backdrop colors
    sampled from the image corners (flood-fill style). If corners are already
    transparent, the image is returned unchanged.
    """
    image = Image.open(BytesIO(image_bytes)).convert("RGBA")
    width, height = image.size
    if width < 4 or height < 4:
        return image_bytes

    pixels = image.load()
    assert pixels is not None

    sample_points = (
        (1, 1),
        (width - 2, 1),
        (1, height - 2),
        (width - 2, height - 2),
        (width // 2, 1),
        (width // 2, height - 2),
        (1, height // 2),
        (width - 2, height // 2),
    )
    corner_alphas = [pixels[x, y][3] for x, y in sample_points[:4]]
    if all(alpha < 24 for alpha in corner_alphas):
        # Already transparent at the corners — keep as-is.
        buf = BytesIO()
        image.save(buf, format="PNG")
        return buf.getvalue()

    # Cluster corner colors; drop any that look like ink (too saturated/dark variance).
    bg_colors: list[tuple[int, int, int]] = []
    for x, y in sample_points:
        r, g, b, a = pixels[x, y]
        if a < 24:
            continue
        bg_colors.append((r, g, b))

    if not bg_colors:
        buf = BytesIO()
        image.save(buf, format="PNG")
        return buf.getvalue()

    # Use unique-ish backgrounds; prefer the most common-ish by first sample.
    unique_bgs: list[tuple[int, int, int]] = []
    for color in bg_colors:
        if not any(_near(color, existing, tolerance) for existing in unique_bgs):
            unique_bgs.append(color)

    # Flood from edges for each background color cluster.
    visited = [[False] * width for _ in range(height)]
    stack: list[tuple[int, int]] = []

    def maybe_push(x: int, y: int) -> None:
        if x < 0 or y < 0 or x >= width or y >= height or visited[y][x]:
            return
        r, g, b, a = pixels[x, y]
        if a < 24:
            visited[y][x] = True
            return
        if any(_near((r, g, b), bg, tolerance) for bg in unique_bgs):
            stack.append((x, y))
            visited[y][x] = True

    for x in range(width):
        maybe_push(x, 0)
        maybe_push(x, height - 1)
    for y in range(height):
        maybe_push(0, y)
        maybe_push(width - 1, y)

    while stack:
        x, y = stack.pop()
        pixels[x, y] = (0, 0, 0, 0)
        maybe_push(x + 1, y)
        maybe_push(x - 1, y)
        maybe_push(x, y + 1)
        maybe_push(x, y - 1)

    buf = BytesIO()
    image.save(buf, format="PNG")
    return buf.getvalue()


def _near(
    color: tuple[int, int, int],
    other: tuple[int, int, int],
    tolerance: int,
) -> bool:
    return (
        abs(color[0] - other[0]) <= tolerance
        and abs(color[1] - other[1]) <= tolerance
        and abs(color[2] - other[2]) <= tolerance
    )
