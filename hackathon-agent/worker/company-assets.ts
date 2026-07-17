import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
import { getPublicBaseUrl, type Env } from "./types";
import {
  chromaticHexes,
  downloadPreferredLogo,
  enrichBrandColors,
  guessDomain,
  lookupBrand,
  type BrandProfile,
} from "./brand-lookup";

/**
 * Get_company_assets: company NAME → real brand kit (logo, colors, slogan).
 *
 * The jersey-studio pipeline (brand_lookup.py), worker-side:
 *   name → Context.dev/Brand.dev (API key) → Zero-paid brand lookup →
 *   normalize (title/domain/slogan/≤8 colors/ranked logos) → website CSS
 *   color scrape only when no chromatic color survived → OpenRouter
 *   web-search fallback → download the preferred raster logo.
 *
 * The logo BYTES are persisted in R2 (ASSETS_BUCKET) and served back via
 * GET /files/<key>, so every tool gets a stable https URL — Generate_merch
 * turns it into the base64 input_reference for gpt-image-2. When the brand
 * services yield no logo at all, the previous homepage scrape (og:image /
 * icons / Clearbit / Google favicon) still guarantees usable image assets.
 * Re-calls within 24h return the cached kit (per-company Durable Object).
 */

export const getCompanyAssetsInputSchema = z.object({
  company: z.string().trim().min(2).max(300)
    .describe('Company name (preferred, e.g. "Anthropic") — a website domain/URL also works'),
  refresh: z.boolean().optional()
    .describe("Force a fresh lookup even if a cached brand kit exists (default false)"),
});
export type GetCompanyAssetsInput = z.infer<typeof getCompanyAssetsInputSchema>;

export type CompanyAsset = {
  key: string;
  url: string;
  kind: "logo" | "og_image" | "icon" | "image";
  content_type: string;
  bytes: number;
  source_url: string;
};

type BrandIndex = {
  company: string;
  fetched_at: string;
  brand: {
    title: string;
    domain: string;
    slogan: string;
    colors: string[];
    source: string;
  } | null;
  assets: CompanyAsset[];
};

const INDEX_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_FALLBACK_ASSETS = 4;
const MAX_ASSET_BYTES = 4 * 1024 * 1024;
const MIN_ASSET_BYTES = 400;
const MAX_HTML_BYTES = 3 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15_000;

/** Per-company brand kit cache. Bytes live in R2; this DO is the reference
 * the rest of the system reads (and the 24h lookup cache). */
export class CompanyAssets extends DurableObject {
  async getIndex(): Promise<BrandIndex | null> {
    return (await this.ctx.storage.get<BrandIndex>("brand_index")) ?? null;
  }

  async putIndex(index: BrandIndex): Promise<void> {
    await this.ctx.storage.put("brand_index", index);
  }
}

export function normalizeDomain(input: string): string | null {
  const trimmed = input.trim();
  try {
    const url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    if (!host.includes(".")) return null;
    return host;
  } catch {
    return null;
  }
}

async function fetchWithTimeout(url: string, accept: string): Promise<Response | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36 hackathon-agent",
        accept,
      },
    });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------ fallback: homepage image scrape ------------------- */
/* Used only when the brand pipeline produced no downloadable logo. */

type Candidate = { url: string; kind: CompanyAsset["kind"]; priority: number };

/** Parse the homepage with HTMLRewriter, collecting asset candidates. */
async function collectHomepageCandidates(domain: string): Promise<Candidate[]> {
  const response = await fetchWithTimeout(`https://${domain}/`, "text/html,application/xhtml+xml");
  if (!response || !response.ok) return [];
  const pageUrl = response.url || `https://${domain}/`;

  const candidates: Candidate[] = [];
  const push = (raw: string | null | undefined, kind: CompanyAsset["kind"], priority: number) => {
    if (!raw) return;
    try {
      const absolute = new URL(raw, pageUrl).toString();
      if (!/^https?:\/\//i.test(absolute)) return;
      if (absolute.startsWith("data:")) return;
      candidates.push({ url: absolute, kind, priority });
    } catch {
      /* unparseable URL — skip */
    }
  };

  const looksLikeLogo = (value: string | null) => !!value && /logo|brand|wordmark/i.test(value);

  const rewriter = new HTMLRewriter()
    .on("meta", {
      element(el) {
        const key = (el.getAttribute("property") ?? el.getAttribute("name") ?? "").toLowerCase();
        if (key === "og:image" || key === "og:image:url" || key === "og:image:secure_url" || key === "twitter:image") {
          push(el.getAttribute("content"), "og_image", 30);
        }
      },
    })
    .on("link", {
      element(el) {
        const rel = (el.getAttribute("rel") ?? "").toLowerCase();
        if (rel.includes("icon")) {
          push(el.getAttribute("href"), "icon", rel.includes("apple-touch") ? 40 : 60);
        }
      },
    })
    .on("img", {
      element(el) {
        const src = el.getAttribute("src");
        const hints = [src, el.getAttribute("alt"), el.getAttribute("class"), el.getAttribute("id")];
        if (hints.some((hint) => looksLikeLogo(hint ?? null))) {
          push(src, "logo", 20);
        }
      },
    });

  // Drive the parser; cap how much HTML we pull through it.
  const transformed = rewriter.transform(response);
  const reader = transformed.body?.getReader();
  if (reader) {
    let consumed = 0;
    while (consumed < MAX_HTML_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      consumed += value?.byteLength ?? 0;
    }
    await reader.cancel().catch(() => undefined);
  }

  return candidates;
}

function extensionFor(contentType: string): string {
  if (contentType.includes("svg")) return "svg";
  if (contentType.includes("png")) return "png";
  if (contentType.includes("webp")) return "webp";
  if (contentType.includes("gif")) return "gif";
  if (contentType.includes("icon") || contentType.includes("ico")) return "ico";
  return "jpg";
}

/** Download + store the best scraped homepage candidates (Clearbit and
 * Google-favicon fallbacks included, so a real domain always yields ≥1). */
async function scrapeFallbackAssets(env: Env, domain: string, keyPrefix: string): Promise<CompanyAsset[]> {
  const candidates = await collectHomepageCandidates(domain);
  candidates.push({ url: `https://logo.clearbit.com/${domain}`, kind: "logo", priority: 10 });
  candidates.push({ url: `https://www.google.com/s2/favicons?domain=${domain}&sz=256`, kind: "icon", priority: 90 });

  const seen = new Set<string>();
  const ranked = candidates
    .sort((left, right) => left.priority - right.priority)
    .filter((candidate) => {
      if (seen.has(candidate.url)) return false;
      seen.add(candidate.url);
      return true;
    });

  const base = getPublicBaseUrl(env);
  const assets: CompanyAsset[] = [];
  for (const candidate of ranked) {
    if (assets.length >= MAX_FALLBACK_ASSETS) break;
    const response = await fetchWithTimeout(candidate.url, "image/*,*/*;q=0.5");
    if (!response || !response.ok) continue;
    const contentType = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() ?? "";
    if (!contentType.startsWith("image/")) continue;
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength < MIN_ASSET_BYTES || buffer.byteLength > MAX_ASSET_BYTES) continue;
    const key = `${keyPrefix}/${assets.length}-${candidate.kind}.${extensionFor(contentType)}`;
    await env.ASSETS_BUCKET.put(key, buffer, { httpMetadata: { contentType } });
    assets.push({
      key,
      url: `${base}/files/${key}`,
      kind: candidate.kind,
      content_type: contentType,
      bytes: buffer.byteLength,
      source_url: candidate.url,
    });
  }
  return assets;
}

/* -------------------------------- executor -------------------------------- */

function companySlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "company";
}

function indexResult(index: BrandIndex, cached: boolean): Record<string, unknown> {
  const brand = index.brand;
  const chromatic = brand ? chromaticHexes(brand.colors) : [];
  // gpt-image-2 rejects SVG input references, so logo_url must be raster;
  // SVG assets stay in the list for chat display only.
  const raster = index.assets.filter((asset) => !asset.content_type.includes("svg"));
  const logo = raster.find((asset) => asset.kind === "logo") ?? raster[0] ?? null;
  return {
    company: index.company,
    cached,
    fetched_at: index.fetched_at,
    ...(brand ? {
      title: brand.title || index.company,
      domain: brand.domain || undefined,
      slogan: brand.slogan || undefined,
      brand_colors: brand.colors,
      chromatic_colors: chromatic,
      brand_source: brand.source,
    } : {}),
    ...(logo ? { logo_url: logo.url } : {}),
    assets: index.assets.map(({ url, kind, content_type }) => ({ url, kind, content_type })),
    note: (logo
      ? "Pass logo_url as Generate_merch's brand_image (it becomes the gpt-image-2 logo reference). "
      : "No downloadable logo was found — designs will infer the brand from the name. ")
      + (chromatic.length > 0
        ? `Real brand accent hexes: ${chromatic.join(", ")} — include them in the design brief as the COLOR LOCK.`
        : "No chromatic brand colors were found; let the art director infer a palette.")
      + (cached ? " (Cached — refresh=true re-runs the lookup.)" : ""),
  };
}

export async function executeGetCompanyAssets(
  env: Env,
  input: GetCompanyAssetsInput,
): Promise<Record<string, unknown>> {
  // A domain/URL input still works: it becomes the scrape/Zero domain hint,
  // and the first label doubles as the lookup name ("anthropic.com" → "anthropic").
  const raw = input.company.trim();
  const looksLikeUrl = /^https?:\/\//i.test(raw) || (/\./.test(raw) && !/\s/.test(raw));
  const domainHint = looksLikeUrl ? normalizeDomain(raw) : null;
  const name = domainHint ? domainHint.split(".")[0] : raw;
  if (name.length < 2) {
    return { error: `"${input.company}" is not a usable company name or domain.`, code: "INVALID_COMPANY" };
  }
  if (!env.ASSETS_BUCKET) {
    return { error: "ASSETS_BUCKET (R2) is not configured.", code: "MISSING_BUCKET" };
  }

  const cacheKey = domainHint ?? companySlug(name);
  const stub = env.CompanyAssets.get(env.CompanyAssets.idFromName(cacheKey)) as unknown as CompanyAssets;

  // 24h cache: the DO index is the source of truth for what's in R2.
  if (input.refresh !== true) {
    const existing = await stub.getIndex();
    if (existing && Date.now() - Date.parse(existing.fetched_at) < INDEX_TTL_MS
      && (existing.brand !== null || existing.assets.length > 0)) {
      return indexResult(existing, true);
    }
  }

  // 1-3) Brand lookup (API key → Zero-paid) + normalization.
  let brand: BrandProfile | null = await lookupBrand(env, name, domainHint);
  if (brand && !brand.domain && domainHint) brand.domain = domainHint;

  // 4-5) Color enrichment only when no chromatic color survived:
  // website CSS scrape, then OpenRouter web search.
  brand = await enrichBrandColors(env, name, brand, domainHint);

  // 6) Download the preferred logo → R2 (stable URL for chat + gpt-image-2).
  const keyPrefix = `companies/${cacheKey}`;
  const assets: CompanyAsset[] = [];
  if (brand) {
    const logo = await downloadPreferredLogo(brand);
    if (logo) {
      const extension = extensionFor(logo.mediaType);
      const key = `${keyPrefix}/logo.${extension}`;
      await env.ASSETS_BUCKET.put(key, logo.bytes, { httpMetadata: { contentType: logo.mediaType } });
      assets.push({
        key,
        url: `${getPublicBaseUrl(env)}/files/${key}`,
        kind: "logo",
        content_type: logo.mediaType,
        bytes: logo.bytes.byteLength,
        source_url: brand.logoUrls[0] ?? "",
      });
    }
  }

  // Fallback: no logo from the brand services → previous homepage scrape.
  if (assets.length === 0) {
    const domain = brand?.domain?.trim().toLowerCase() || domainHint || guessDomain(name, brand);
    if (domain) assets.push(...await scrapeFallbackAssets(env, domain, keyPrefix));
  }

  if (!brand && assets.length === 0) {
    return {
      error: `No brand data or image assets found for "${name}". Designs can still infer the brand from the company name.`,
      code: "NO_BRAND_FOUND",
    };
  }

  const index: BrandIndex = {
    company: brand?.title || name,
    fetched_at: new Date().toISOString(),
    brand: brand
      ? {
        title: brand.title,
        domain: brand.domain,
        slogan: brand.slogan,
        colors: brand.colorHexes,
        source: brand.source,
      }
      : null,
    assets,
  };
  await stub.putIndex(index);

  return indexResult(index, false);
}
