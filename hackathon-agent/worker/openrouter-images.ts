import type { Env } from "./types";

/**
 * Thin OpenRouter Images API client for openai/gpt-image-2 — the worker port
 * of jersey-app/openrouter_images.py from the jersey-studio branch. Returns
 * raw PNG bytes; optional input_references guide the generation (brand logo,
 * prior attempt on a critic redo).
 */

const OPENROUTER_IMAGES_URL = "https://openrouter.ai/api/v1/images";
const DEFAULT_MODEL = "openai/gpt-image-2";
const GENERATION_TIMEOUT_MS = 240_000;

// openai/gpt-image-2 aspect_ratio enum (OpenRouter Zod schema).
const ALLOWED_ASPECT_RATIOS = new Set([
  "1:1", "1:2", "1:4", "1:8", "2:1", "2:3", "3:2", "3:4", "4:1", "4:3", "4:5",
  "5:4", "8:1", "9:16", "16:9", "9:19.5", "19.5:9", "9:20", "20:9", "9:21", "21:9", "auto",
]);
// Common aliases → nearest allowed ratio.
const ASPECT_ALIASES: Record<string, string> = { "3:1": "2:1", "5:1": "4:1", "5:2": "2:1", "5:3": "3:2" };

export class OpenRouterImageError extends Error {}

function normalizeAspectRatio(aspectRatio: string): string {
  const value = aspectRatio.trim() || "1:1";
  if (ALLOWED_ASPECT_RATIOS.has(value)) return value;
  const mapped = ASPECT_ALIASES[value];
  if (mapped) return mapped;
  throw new OpenRouterImageError(`Unsupported aspect_ratio "${aspectRatio}".`);
}

export function hasOpenRouter(env: Env): boolean {
  return !!env.OPENROUTER_API_KEY?.trim();
}

export type ImageReference = { type: "image_url"; image_url: { url: string } };

export function referenceFromDataUri(dataUri: string): ImageReference {
  return { type: "image_url", image_url: { url: dataUri } };
}

export async function generateImage(
  env: Env,
  prompt: string,
  options: { references?: ImageReference[]; aspectRatio?: string; quality?: string } = {},
): Promise<Uint8Array> {
  const apiKey = env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) throw new OpenRouterImageError("OPENROUTER_API_KEY is not configured.");

  const payload: Record<string, unknown> = {
    model: env.OPENROUTER_IMAGE_MODEL?.trim() || DEFAULT_MODEL,
    prompt,
    quality: options.quality ?? "medium",
    output_format: "png",
    aspect_ratio: normalizeAspectRatio(options.aspectRatio ?? "1:1"),
    n: 1,
  };
  if (options.references && options.references.length > 0) {
    payload.input_references = options.references;
  }

  const response = await fetch(OPENROUTER_IMAGES_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      "x-title": "hackathon-agent",
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(GENERATION_TIMEOUT_MS),
  });

  const text = await response.text();
  let result: unknown = null;
  try {
    result = JSON.parse(text);
  } catch {
    throw new OpenRouterImageError(`Invalid JSON from OpenRouter (${response.status}): ${text.slice(0, 300)}`);
  }
  if (!response.ok) {
    const detail = (result as { error?: unknown })?.error ?? text.slice(0, 300);
    throw new OpenRouterImageError(`OpenRouter error ${response.status}: ${JSON.stringify(detail).slice(0, 500)}`);
  }

  const data = (result as { data?: Array<{ b64_json?: string }> })?.data;
  const b64 = Array.isArray(data) ? data[0]?.b64_json : undefined;
  if (!b64) throw new OpenRouterImageError(`No b64_json in OpenRouter response: ${text.slice(0, 300)}`);

  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
