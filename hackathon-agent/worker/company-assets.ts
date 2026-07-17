import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
import { getPublicBaseUrl, type Env } from "./types";

/**
 * Get_company_assets: company URL → brand image assets.
 *
 * Design: scrape the company homepage with HTMLRewriter (og:image /
 * twitter:image, icon links, logo-heuristic <img> tags), add the Clearbit
 * logo API and Google's favicon service as high-reliability candidates,
 * download the best few, and persist the BYTES in R2 (ASSETS_BUCKET) with
 * the INDEX in a per-domain CompanyAssets Durable Object. Assets are served
 * back via GET /assets/<key>, so every tool (and the chat UI) gets stable
 * https URLs. Re-calls within 24h return the cached index.
 */

export const getCompanyAssetsInputSchema = z.object({
  company_url: z.string().trim().min(3).max(300)
    .describe('Company website URL or bare domain, e.g. "anthropic.com" or "https://stripe.com"'),
  refresh: z.boolean().optional()
    .describe("Force a re-scrape even if a fresh cached index exists (default false)"),
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

type AssetIndex = {
  domain: string;
  fetched_at: string;
  assets: CompanyAsset[];
};

const INDEX_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ASSETS = 8;
const MAX_ASSET_BYTES = 4 * 1024 * 1024;
const MIN_ASSET_BYTES = 400;
const MAX_HTML_BYTES = 3 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15_000;

/** Per-domain asset index. Bytes live in R2; this DO is the reference the
 * rest of the system reads (and the 24h scrape cache). */
export class CompanyAssets extends DurableObject {
  async getIndex(): Promise<AssetIndex | null> {
    return (await this.ctx.storage.get<AssetIndex>("index")) ?? null;
  }

  async putIndex(index: AssetIndex): Promise<void> {
    await this.ctx.storage.put("index", index);
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

type Candidate = { url: string; kind: CompanyAsset["kind"]; priority: number };

/** Parse the homepage with HTMLRewriter, collecting asset candidates. */
async function collectHomepageCandidates(domain: string): Promise<{ candidates: Candidate[]; pageUrl: string | null }> {
  const response = await fetchWithTimeout(`https://${domain}/`, "text/html,application/xhtml+xml");
  if (!response || !response.ok) return { candidates: [], pageUrl: null };
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

  return { candidates, pageUrl };
}

function extensionFor(contentType: string): string {
  if (contentType.includes("svg")) return "svg";
  if (contentType.includes("png")) return "png";
  if (contentType.includes("webp")) return "webp";
  if (contentType.includes("gif")) return "gif";
  if (contentType.includes("icon") || contentType.includes("ico")) return "ico";
  return "jpg";
}

export async function executeGetCompanyAssets(
  env: Env,
  input: GetCompanyAssetsInput,
): Promise<Record<string, unknown>> {
  const domain = normalizeDomain(input.company_url);
  if (!domain) {
    return { error: `"${input.company_url}" is not a usable company URL or domain.`, code: "INVALID_COMPANY_URL" };
  }
  if (!env.ASSETS_BUCKET) {
    return { error: "ASSETS_BUCKET (R2) is not configured.", code: "MISSING_BUCKET" };
  }

  const stub = env.CompanyAssets.get(env.CompanyAssets.idFromName(domain)) as unknown as CompanyAssets;

  // 24h cache: the DO index is the source of truth for what's in R2.
  if (input.refresh !== true) {
    const existing = await stub.getIndex();
    if (existing && Date.now() - Date.parse(existing.fetched_at) < INDEX_TTL_MS && existing.assets.length > 0) {
      return {
        company: domain,
        cached: true,
        fetched_at: existing.fetched_at,
        assets: existing.assets.map(({ url, kind, content_type }) => ({ url, kind, content_type })),
        note: "Cached from an earlier scrape (re-run with refresh=true to re-scrape).",
      };
    }
  }

  // Candidate set: homepage scrape + always-on fallbacks. Clearbit's logo
  // API is the single most reliable "give me the company logo" source, so
  // it ranks first; Google's favicon service is the floor that guarantees
  // at least one asset for any real domain.
  const { candidates } = await collectHomepageCandidates(domain);
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
  const failures: string[] = [];

  for (const candidate of ranked) {
    if (assets.length >= MAX_ASSETS) break;
    const response = await fetchWithTimeout(candidate.url, "image/*,*/*;q=0.5");
    if (!response || !response.ok) {
      failures.push(candidate.url);
      continue;
    }
    const contentType = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() ?? "";
    if (!contentType.startsWith("image/")) {
      failures.push(candidate.url);
      continue;
    }
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength < MIN_ASSET_BYTES || buffer.byteLength > MAX_ASSET_BYTES) {
      failures.push(candidate.url);
      continue;
    }
    const key = `companies/${domain}/${assets.length}-${candidate.kind}.${extensionFor(contentType)}`;
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

  if (assets.length === 0) {
    return {
      error: `Could not retrieve any image assets for ${domain} (tried ${ranked.length} candidates).`,
      code: "NO_ASSETS_FOUND",
    };
  }

  const index: AssetIndex = { domain, fetched_at: new Date().toISOString(), assets };
  await stub.putIndex(index);

  return {
    company: domain,
    cached: false,
    fetched_at: index.fetched_at,
    assets: assets.map(({ url, kind, content_type }) => ({ url, kind, content_type })),
    note: `Stored ${assets.length} asset${assets.length === 1 ? "" : "s"} in R2; URLs are stable and usable in other tools (e.g. as Order_custom_product design images).`,
  };
}
