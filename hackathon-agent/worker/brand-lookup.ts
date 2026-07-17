import type { Env } from "./types";
import { CAPABILITIES, zeroFetch, ZeroError } from "./zero";

/**
 * Brand lookup — the worker port of jersey-app/brand_lookup.py from the
 * jersey-studio branch (loop-eng-hackathon @ 6ae344c).
 *
 * Company name →
 *   1. Context.dev / Brand.dev retrieve-by-name (BRAND_DEV_API_KEY or
 *      CONTEXT_DEV_API_KEY)
 *   2. Zero-paid brand lookup if needed — the reference shelled out to the
 *      Zero CLI for Brand.dev's capability, but that settles via MPP on
 *      Tempo, which only the CLI's payment stack can do (see zero.ts). The
 *      worker instead pays the x402-on-Base StatePulse Brand Assets Lookup
 *      (~$0.02): logo URL + brand color hexes by domain.
 *   3. Normalize into a BrandProfile (title, domain, slogan, ≤8 colors,
 *      ranked raster logo URLs — logo over icon, transparent/light modes
 *      preferred, SVG excluded).
 *   4. Scrape the company homepage + linked CSS for frequent chromatic hexes
 *      ONLY when the profile has no usable chromatic color.
 *   5. OpenRouter web-search fallback (openai/gpt-4.1-mini:online) when the
 *      CSS scrape yields nothing.
 *   6. Download the preferred logo (first 5 ranked URLs, redirects followed,
 *      SVG and <64-byte responses rejected) for use as a base64 reference to
 *      gpt-image-2.
 *
 * Failures are soft — callers fall back to name-only inference.
 */

const CONTEXT_RETRIEVE_URL = "https://api.context.dev/v1/brand/retrieve";
const BRAND_DEV_BY_NAME_URL = "https://api.brand.dev/v1/brand/retrieve-by-name";

const API_TIMEOUT_MS = 45_000;
const SCRAPE_TIMEOUT_MS = 25_000;
const WEB_SEARCH_TIMEOUT_MS = 90_000;
const LOGO_TIMEOUT_MS = 30_000;
const MAX_LOGO_BYTES = 4 * 1024 * 1024;
const MAX_CSS_FETCHES = 6;

const RASTER_EXTS = [".png", ".jpg", ".jpeg", ".webp", ".gif"];
const SVG_HINTS = [".svg", "image/svg"];

export type BrandProfile = {
  title: string;
  domain: string;
  slogan: string;
  colorHexes: string[];
  logoUrls: string[];
  source: string;
};

export function hasVisualCues(brand: BrandProfile): boolean {
  return brand.colorHexes.length > 0 || brand.logoUrls.length > 0 || !!brand.slogan;
}

function apiKey(env: Env): string {
  return env.BRAND_DEV_API_KEY?.trim() || env.CONTEXT_DEV_API_KEY?.trim() || "";
}

/* ------------------------------ hex utilities ----------------------------- */

function parseHex(hexValue: string): [number, number, number] | null {
  let raw = hexValue.trim().replace(/^#/, "");
  if (raw.length === 3) raw = raw.split("").map((ch) => ch + ch).join("");
  if (raw.length !== 6 || !/^[0-9a-fA-F]{6}$/.test(raw)) return null;
  return [
    Number.parseInt(raw.slice(0, 2), 16),
    Number.parseInt(raw.slice(2, 4), 16),
    Number.parseInt(raw.slice(4, 6), 16),
  ];
}

/** True for near-black, near-white, or low-chroma grays — useless print accents. */
function isNearNeutral(hexValue: string): boolean {
  const rgb = parseHex(hexValue);
  if (!rgb) return true;
  const [r, g, b] = rgb;
  const chroma = (Math.max(r, g, b) - Math.min(r, g, b)) / 255;
  if (chroma < 0.14) return true;
  const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return luminance < 0.08 || luminance > 0.92;
}

/** Brand colors that are actually usable as print accents (not pure neutrals). */
export function chromaticHexes(hexes: string[]): string[] {
  return hexes.filter((hexValue) => !isNearNeutral(hexValue));
}

/** Brand.dev often returns only a near-black logo ink — treat that as missing. */
export function paletteNeedsEnrichment(hexes: string[]): boolean {
  return chromaticHexes(hexes).length === 0;
}

function normalizeHex(raw: string): string | null {
  let value = raw.trim().replace(/^#/, "");
  if (value.length === 3) value = value.split("").map((ch) => ch + ch).join("");
  if (value.length !== 6 || !/^[0-9a-fA-F]{6}$/.test(value)) return null;
  return `#${value.toLowerCase()}`;
}

function hexesFromColors(colors: unknown): string[] {
  const out: string[] = [];
  if (!Array.isArray(colors)) return out;
  for (const item of colors) {
    let hexValue = "";
    if (item && typeof item === "object") {
      hexValue = String((item as Record<string, unknown>).hex ?? "").trim();
    } else {
      hexValue = String(item ?? "").trim();
    }
    if (hexValue && !hexValue.startsWith("#")) hexValue = `#${hexValue}`;
    if (hexValue && !out.includes(hexValue)) out.push(hexValue);
  }
  return out;
}

/* --------------------------- payload normalization ------------------------ */

function isRasterUrl(url: string): boolean {
  const lower = url.toLowerCase().split("?", 1)[0];
  if (RASTER_EXTS.some((ext) => lower.endsWith(ext))) return true;
  if (SVG_HINTS.some((hint) => lower.includes(hint))) return false;
  // Unknown extension — treat as usable (Brand.dev often serves jpg without ext).
  return true;
}

/** Rank logos: type=logo over icon, transparent/light modes preferred; no SVG. */
function logoUrlsFromBrand(brand: Record<string, unknown>): string[] {
  const logos = brand.logos;
  if (!Array.isArray(logos)) return [];

  const scored: Array<[number, string]> = [];
  for (const logo of logos) {
    if (!logo || typeof logo !== "object") continue;
    const entry = logo as Record<string, unknown>;
    const url = String(entry.url ?? "").trim();
    if (!/^https?:\/\//.test(url)) continue;
    if (!isRasterUrl(url)) continue;
    const logoType = String(entry.type ?? "").toLowerCase();
    const mode = String(entry.mode ?? "").toLowerCase();
    let score = 0;
    if (logoType === "logo") score += 30;
    else if (logoType === "icon") score += 20;
    if (mode.includes("transparent") || mode === "light") score += 5;
    if (mode === "has_opaque_background") score += 2;
    scored.push([score, url]);
  }

  scored.sort((left, right) => right[0] - left[0]);
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const [, url] of scored) {
    if (!seen.has(url)) {
      seen.add(url);
      urls.push(url);
    }
  }
  return urls;
}

/** Normalize Brand.dev / Context.dev JSON into a BrandProfile. */
export function parseBrandPayload(payload: unknown, source: string): BrandProfile | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;

  let brand: Record<string, unknown> | null =
    record.brand && typeof record.brand === "object" && !Array.isArray(record.brand)
      ? record.brand as Record<string, unknown>
      : null;
  if (!brand) {
    const data = record.data;
    if (data && typeof data === "object" && !Array.isArray(data)
      && (data as Record<string, unknown>).brand
      && typeof (data as Record<string, unknown>).brand === "object") {
      brand = (data as Record<string, unknown>).brand as Record<string, unknown>;
    } else if ("logos" in record || "colors" in record || "title" in record) {
      brand = record;
    } else {
      return null;
    }
  }

  const title = String(brand.title ?? brand.name ?? "").trim();
  const domain = String(brand.domain ?? "").trim();
  const slogan = String(brand.slogan ?? brand.description ?? "").trim();
  const profile: BrandProfile = {
    title,
    domain,
    slogan: slogan.slice(0, 240),
    colorHexes: hexesFromColors(brand.colors).slice(0, 8),
    logoUrls: logoUrlsFromBrand(brand),
    source,
  };
  if (!hasVisualCues(profile) && !profile.title) return null;
  return profile;
}

/* ------------------------------- lookups ---------------------------------- */

async function fetchJson(url: string, init: RequestInit, timeoutMs: number): Promise<{ status: number; body: unknown } | null> {
  try {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    const text = await response.text();
    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    return { status: response.status, body };
  } catch (error) {
    console.warn(`brand lookup request failed for ${url}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/** Context.dev unified retrieve first, then legacy Brand.dev GET. */
async function lookupViaApiKey(env: Env, companyName: string): Promise<BrandProfile | null> {
  const key = apiKey(env);
  if (!key) return null;
  const name = companyName.trim().slice(0, 30);
  if (name.length < 3) return null;

  const contextResult = await fetchJson(
    CONTEXT_RETRIEVE_URL,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({ type: "by_name", name, maxSpeed: true }),
    },
    API_TIMEOUT_MS,
  );
  if (contextResult && contextResult.status < 400) {
    const profile = parseBrandPayload(contextResult.body, "context.dev");
    if (profile) return profile;
  }

  const brandDevResult = await fetchJson(
    `${BRAND_DEV_BY_NAME_URL}?name=${encodeURIComponent(name)}`,
    { headers: { authorization: `Bearer ${key}`, accept: "application/json" } },
    API_TIMEOUT_MS,
  );
  if (brandDevResult && brandDevResult.status < 400) {
    const profile = parseBrandPayload(brandDevResult.body, "brand.dev");
    if (profile) return profile;
  }
  return null;
}

type StatePulseResponse = {
  supported?: boolean;
  confidence?: string;
  result?: { logo?: string | null; colors?: unknown };
};

/**
 * Zero-paid lookup (x402 on Base, ~$0.02). StatePulse resolves by DOMAIN, so
 * the caller passes the Brand.dev domain when known or the guessed one.
 */
async function lookupViaZero(env: Env, companyName: string, domain: string | null): Promise<BrandProfile | null> {
  if (!env.X402_PRIVATE_KEY?.trim()) return null;
  // Match the reference gating: with an API key configured, Zero is only
  // attempted when BRAND_LOOKUP_VIA_ZERO is explicitly enabled.
  const force = ["1", "true", "yes"].includes((env.BRAND_LOOKUP_VIA_ZERO ?? "").trim().toLowerCase());
  if (apiKey(env) && !force) return null;
  if (!domain) return null;

  let payload: StatePulseResponse;
  try {
    payload = await zeroFetch<StatePulseResponse>(env, {
      label: CAPABILITIES.brandAssets.label,
      url: CAPABILITIES.brandAssets.url,
      method: "POST",
      body: { domain },
      timeoutMs: CAPABILITIES.brandAssets.timeoutMs,
    });
  } catch (error) {
    if (error instanceof ZeroError) {
      console.warn(`zero brand lookup failed (${error.code}): ${error.message}`);
      return null;
    }
    throw error;
  }

  if (!payload?.supported || !payload.result) return null;
  const logo = String(payload.result.logo ?? "").trim();
  const profile: BrandProfile = {
    title: companyName.trim(),
    domain,
    slogan: "",
    colorHexes: hexesFromColors(payload.result.colors).slice(0, 8),
    logoUrls: /^https?:\/\//.test(logo) && isRasterUrl(logo) ? [logo] : [],
    source: "zero:statepulse",
  };
  return hasVisualCues(profile) ? profile : null;
}

/** Very light domain heuristic — only for enrichment, never authoritative. */
export function guessDomain(companyName: string, brand: BrandProfile | null): string | null {
  const fromBrand = brand?.domain?.trim().toLowerCase().replace(/^\.+/, "");
  if (fromBrand) return fromBrand;
  const slug = companyName.trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
  return slug.length >= 3 ? `${slug}.com` : null;
}

/** Resolve a brand kit for a company name. Never throws — null on miss. */
export async function lookupBrand(env: Env, companyName: string, domainHint: string | null = null): Promise<BrandProfile | null> {
  const name = (companyName ?? "").trim();
  if (name.length < 3) return null;

  try {
    const viaKey = await lookupViaApiKey(env, name);
    if (viaKey) return viaKey;
    return await lookupViaZero(env, name, domainHint ?? guessDomain(name, null));
  } catch (error) {
    console.error(`brand lookup unexpected error for "${name}": ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/* --------------------------- palette enrichment --------------------------- */

async function fetchText(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(SCRAPE_TIMEOUT_MS),
      headers: {
        "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36 hackathon-agent",
        accept: "text/html,text/css,*/*;q=0.5",
      },
    });
    if (!response.ok) return null;
    return await response.text();
  } catch {
    return null;
  }
}

/** Scrape homepage + linked CSS for frequent chromatic hexes (top 8). */
async function colorsFromWebsite(domain: string): Promise<string[]> {
  const base = `https://${domain}`;
  const counts = new Map<string, number>();
  const count = (raw: string) => {
    const normalized = normalizeHex(raw);
    if (normalized && !isNearNeutral(normalized)) {
      counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
    }
  };

  const html = await fetchText(base);
  if (!html) return [];
  for (const match of html.match(/#[0-9A-Fa-f]{3,6}\b/g) ?? []) count(match);

  const hrefs = [...html.matchAll(/(?:href|src)=["']([^"']+\.css[^"']*)["']/gi)].map((match) => match[1]);
  const seen = new Set<string>();
  for (const href of hrefs) {
    let url: string;
    try {
      url = new URL(href, `${base}/`).toString();
    } catch {
      continue;
    }
    if (seen.has(url)) continue;
    seen.add(url);
    if (seen.size > MAX_CSS_FETCHES) break;
    const css = await fetchText(url);
    if (!css) continue;
    for (const match of css.match(/#[0-9A-Fa-f]{6}\b/g) ?? []) count(match);
  }

  if (counts.size === 0) return [];
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 8)
    .map(([hexValue]) => hexValue);
}

/** OpenRouter web-search fallback: ask the live web for the brand's hexes. */
async function colorsFromWebSearch(env: Env, name: string, domain: string | null): Promise<{ colors: string[]; note: string } | null> {
  const key = env.OPENROUTER_API_KEY?.trim();
  if (!key) return null;

  const domainHint = domain ? ` (${domain})` : "";
  const body = {
    model: "openai/gpt-4.1-mini:online",
    plugins: [{ id: "web", max_results: 5 }],
    messages: [
      {
        role: "system",
        content:
          "You are a brand identity researcher. Search the web for the company's "
          + "real visual identity (website CSS, press kit, app UI). "
          + "Return ONLY saturated chromatic brand accents as hex codes "
          + "(purple, violet, blue, teal, green, red, orange, pink, etc.). "
          + "NEVER return black, white, gray, charcoal, off-white, cream, or "
          + "metallic gold unless the brand is literally monochrome gold. "
          + "Respond with JSON only.",
      },
      {
        role: "user",
        content:
          `Company: "${name}"${domainHint}\n`
          + "Brand.dev only returned near-black/neutral hexes — ignore those.\n"
          + "Search the live website and brand pages, then return JSON:\n"
          + '{\n  "colors": ["#RRGGBB", "..."],\n  "notes": "<one short sentence naming the source>"\n}',
      },
    ],
  };

  try {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
        "x-title": "hackathon-agent",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(WEB_SEARCH_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const result = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const content = result.choices?.[0]?.message?.content ?? "";
    const start = content.indexOf("{");
    const end = content.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    const parsed = JSON.parse(content.slice(start, end + 1)) as Record<string, unknown>;
    return {
      colors: hexesFromColors(parsed.colors),
      note: String(parsed.notes ?? "web-search").trim(),
    };
  } catch (error) {
    console.warn(`brand color web search failed for "${name}": ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/**
 * Fill in a real brand palette when Brand.dev/Zero only have neutrals.
 * Prefer scraping the company website CSS (deterministic); fall back to
 * OpenRouter web search. Never accept an all-gray enrichment result.
 */
export async function enrichBrandColors(env: Env, companyName: string, brand: BrandProfile | null, domainHint: string | null = null): Promise<BrandProfile | null> {
  if (brand && !paletteNeedsEnrichment(brand.colorHexes)) return brand;

  const name = (companyName || brand?.title || "").trim();
  if (name.length < 3) return brand;

  let useful: string[] = [];
  const domain = brand?.domain?.trim().toLowerCase() || domainHint || guessDomain(name, brand);
  if (domain) useful = chromaticHexes(await colorsFromWebsite(domain));

  if (useful.length === 0) {
    const searched = await colorsFromWebSearch(env, name, domain);
    if (searched) useful = chromaticHexes(searched.colors);
  }
  if (useful.length === 0) return brand;

  if (!brand) {
    return {
      title: name,
      domain: domain ?? "",
      slogan: "",
      colorHexes: useful.slice(0, 8),
      logoUrls: [],
      source: "web-enrichment",
    };
  }

  const merged: string[] = [];
  for (const hexValue of [...useful, ...brand.colorHexes]) {
    if (!merged.includes(hexValue)) merged.push(hexValue);
  }
  brand.colorHexes = merged.slice(0, 8);
  if (brand.source && !brand.source.includes("+web")) brand.source = `${brand.source}+web`;
  return brand;
}

/* ------------------------------ logo download ----------------------------- */

/** Download the best raster logo (first 5 ranked URLs). Null on total miss. */
export async function downloadPreferredLogo(brand: BrandProfile): Promise<{ bytes: Uint8Array; mediaType: string } | null> {
  for (const url of brand.logoUrls.slice(0, 5)) {
    try {
      const response = await fetch(url, {
        redirect: "follow",
        signal: AbortSignal.timeout(LOGO_TIMEOUT_MS),
        headers: { "user-agent": "hackathon-agent", accept: "image/*,*/*;q=0.5" },
      });
      if (!response.ok) continue;
      const contentType = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
      const bareUrl = url.toLowerCase().split("?", 1)[0];
      if (contentType.includes("svg") || bareUrl.endsWith(".svg")) continue;
      const buffer = await response.arrayBuffer();
      if (buffer.byteLength < 64 || buffer.byteLength > MAX_LOGO_BYTES) continue;
      let mediaType: string;
      if (contentType.startsWith("image/")) mediaType = contentType;
      else if (bareUrl.endsWith(".png")) mediaType = "image/png";
      else if (bareUrl.endsWith(".jpg") || bareUrl.endsWith(".jpeg")) mediaType = "image/jpeg";
      else if (bareUrl.endsWith(".webp")) mediaType = "image/webp";
      else mediaType = "image/png";
      return { bytes: new Uint8Array(buffer), mediaType };
    } catch {
      continue;
    }
  }
  return null;
}
