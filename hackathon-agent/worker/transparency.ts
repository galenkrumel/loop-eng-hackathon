import { decode, encode } from "fast-png";

/**
 * Force a transparent background on print-layer PNGs — the worker port of
 * jersey-app/transparency.py. gpt-image-2 cannot reliably emit alpha, so the
 * generation prompt asks for a flat backdrop (ideally chroma-key #00FF00);
 * this samples the edges for near-uniform backdrop colors and flood-fills
 * them to transparent. Images already transparent at the corners pass
 * through unchanged.
 */

const ALPHA_TRANSPARENT = 24;

function near(a: [number, number, number], b: [number, number, number], tolerance: number): boolean {
  return Math.abs(a[0] - b[0]) <= tolerance
    && Math.abs(a[1] - b[1]) <= tolerance
    && Math.abs(a[2] - b[2]) <= tolerance;
}

export function ensureTransparentBackground(pngBytes: Uint8Array, tolerance = 42): Uint8Array {
  let image;
  try {
    image = decode(pngBytes);
  } catch {
    return pngBytes;
  }
  const { width, height } = image;
  if (width < 4 || height < 4 || image.depth !== 8) return pngBytes;

  // Normalize to RGBA.
  const channels = image.channels;
  const source = image.data as Uint8Array;
  const rgba = channels === 4 ? new Uint8Array(source) : new Uint8Array(width * height * 4);
  if (channels !== 4) {
    for (let pixel = 0; pixel < width * height; pixel += 1) {
      const from = pixel * channels;
      const to = pixel * 4;
      if (channels === 3) {
        rgba[to] = source[from];
        rgba[to + 1] = source[from + 1];
        rgba[to + 2] = source[from + 2];
      } else if (channels === 2) {
        rgba[to] = rgba[to + 1] = rgba[to + 2] = source[from];
      } else {
        rgba[to] = rgba[to + 1] = rgba[to + 2] = source[from];
      }
      rgba[to + 3] = channels === 2 ? source[from + 1] : 255;
    }
  }

  const at = (x: number, y: number): number => (y * width + x) * 4;
  const samplePoints: Array<[number, number]> = [
    [1, 1], [width - 2, 1], [1, height - 2], [width - 2, height - 2],
    [Math.floor(width / 2), 1], [Math.floor(width / 2), height - 2],
    [1, Math.floor(height / 2)], [width - 2, Math.floor(height / 2)],
  ];

  const cornerAlphas = samplePoints.slice(0, 4).map(([x, y]) => rgba[at(x, y) + 3]);
  if (cornerAlphas.every((alpha) => alpha < ALPHA_TRANSPARENT)) {
    // Already transparent at the corners — keep as-is.
    return pngBytes;
  }

  // Cluster edge-sample colors into candidate backdrop colors.
  const backgrounds: Array<[number, number, number]> = [];
  for (const [x, y] of samplePoints) {
    const offset = at(x, y);
    if (rgba[offset + 3] < ALPHA_TRANSPARENT) continue;
    const color: [number, number, number] = [rgba[offset], rgba[offset + 1], rgba[offset + 2]];
    if (!backgrounds.some((existing) => near(color, existing, tolerance))) backgrounds.push(color);
  }
  if (backgrounds.length === 0) return pngBytes;

  // Flood-fill matching backdrop pixels from every edge.
  const visited = new Uint8Array(width * height);
  const stack: number[] = [];
  const maybePush = (x: number, y: number): void => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const pixel = y * width + x;
    if (visited[pixel]) return;
    const offset = pixel * 4;
    if (rgba[offset + 3] < ALPHA_TRANSPARENT) {
      visited[pixel] = 1;
      return;
    }
    const color: [number, number, number] = [rgba[offset], rgba[offset + 1], rgba[offset + 2]];
    if (backgrounds.some((background) => near(color, background, tolerance))) {
      stack.push(pixel);
      visited[pixel] = 1;
    }
  };

  for (let x = 0; x < width; x += 1) {
    maybePush(x, 0);
    maybePush(x, height - 1);
  }
  for (let y = 0; y < height; y += 1) {
    maybePush(0, y);
    maybePush(width - 1, y);
  }

  while (stack.length > 0) {
    const pixel = stack.pop() as number;
    const offset = pixel * 4;
    rgba[offset] = rgba[offset + 1] = rgba[offset + 2] = rgba[offset + 3] = 0;
    const x = pixel % width;
    const y = (pixel - x) / width;
    maybePush(x + 1, y);
    maybePush(x - 1, y);
    maybePush(x, y + 1);
    maybePush(x, y - 1);
  }

  return encode({ width, height, data: rgba, channels: 4, depth: 8 });
}
