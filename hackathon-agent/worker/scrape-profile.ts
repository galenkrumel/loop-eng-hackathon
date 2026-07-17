import { z } from "zod";
import { getPublicBaseUrl, type Env } from "./types";
import { CAPABILITIES, zeroFetch, ZeroError } from "./zero";

/**
 * Scrape_profile: (recruit_name, recruit_linkedin_username)
 *   -> profile image of the recruit + JSON enrichment data.
 *
 * Pipeline (paid Zero x402 capability, verified live 2026-07-17):
 *   LinkedPanda LinkedIn Lookup (~$0.05, x402 v2) — one call yields the
 *   800x800 profile PHOTO and rich enrichment: headline, title, company,
 *   location, `about` (often carries the personal website + GitHub), and
 *   skills.
 *
 * If LinkedIn has no publicly visible photo (avatarUrl null — common when the
 * member restricts photo visibility to logged-in users), profile_image_url is
 * null and a warning says so. There is deliberately NO name-based fallback to
 * other social networks: matching by name alone routinely returns a different
 * person's face, which is far worse on printed swag than no photo at all.
 *
 * The photo BYTES are stored in R2 (like Get_company_assets) and served from
 * /files/<key>, so the returned image URL is stable and renders everywhere.
 * The full raw provider JSON is also written to R2 and linked as `data_url`.
 *
 * (PDL/Minerva — richer still — settle via MPP on Tempo with cross-chain
 * bridging that only the Zero CLI's payment stack performs, so they're not
 * used from the worker. LinkedPanda covers photo + enrichment in one v2 call.)
 */

export const scrapeProfileInputSchema = z.object({
  recruit_name: z.string().trim().min(1).max(120)
    .describe('Recruit full name, e.g. "Constantin Ertel" (used for identity validation)'),
  recruit_linkedin_username: z.string().trim().min(1).max(120)
    .describe('LinkedIn vanity slug from linkedin.com/in/<slug>, e.g. "constantin-ertel" (a full URL is also accepted)'),
  refresh: z.boolean().optional()
    .describe("Force re-scrape + re-pay even if a fresh cached profile exists (default false)"),
});
export type ScrapeProfileInput = z.infer<typeof scrapeProfileInputSchema>;

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MIN_IMAGE_BYTES = 300;

/** Accept a bare slug OR a full linkedin.com/in/... URL, return the slug. */
function normalizeLinkedinUsername(input: string): string | null {
  const trimmed = input.trim();
  const urlMatch = trimmed.match(/linkedin\.com\/in\/([^/?#]+)/i);
  const slug = (urlMatch ? urlMatch[1] : trimmed).replace(/^@/, "").replace(/\/+$/, "").trim();
  if (!slug || /\s/.test(slug) || slug.length > 120) return null;
  return slug;
}

function normalizeName(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Do both name tokens (first + last) appear in `candidate`? Used to flag a
 * LinkedIn username that resolves to a different person than expected. */
function nameMatches(expected: string, candidate: string | null | undefined): boolean {
  if (!candidate) return false;
  const want = normalizeName(expected).split(" ").filter(Boolean);
  const have = new Set(normalizeName(candidate).split(" ").filter(Boolean));
  if (want.length === 0) return false;
  return have.has(want[0]) && have.has(want[want.length - 1]);
}

/** LinkedPanda returns topSkills as a Postgres-style array string:
 * `{"SQL","Microsoft Excel",...}`. Pull the quoted values out. */
function parseSkills(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((s): s is string => typeof s === "string");
  if (typeof raw !== "string") return [];
  return [...raw.matchAll(/"([^"]+)"/g)].map((m) => m[1]).slice(0, 25);
}

/** Pull a personal website + GitHub out of a free-text `about`/bio. */
function extractLinks(about: unknown): { website: string | null; github: string | null } {
  const text = typeof about === "string" ? about : "";
  const github = text.match(/(?:https?:\/\/)?(?:www\.)?github\.com\/[A-Za-z0-9_-]+/i)?.[0] ?? null;
  // First non-github/linkedin URL or bare domain as the website.
  const urls = [...text.matchAll(/(?:https?:\/\/)?(?:www\.)?([a-z0-9-]+\.[a-z]{2,}(?:\/[^\s]*)?)/gi)]
    .map((m) => m[0])
    .filter((u) => !/github\.com|linkedin\.com|instagram\.com|twitter\.com|x\.com/i.test(u));
  const website = urls[0] ?? null;
  return {
    website: website ? (website.startsWith("http") ? website : `https://${website}`) : null,
    github: github ? (github.startsWith("http") ? github : `https://${github}`) : null,
  };
}

function imageExtension(contentType: string): string {
  if (contentType.includes("png")) return "png";
  if (contentType.includes("webp")) return "webp";
  if (contentType.includes("gif")) return "gif";
  return "jpg";
}

/** Download an image URL and persist it to R2, returning a stable /files URL. */
async function storeImage(
  env: Env,
  sourceUrl: string,
  key: string,
): Promise<{ url: string; content_type: string; bytes: number } | null> {
  let response: Response;
  try {
    response = await fetch(sourceUrl, {
      redirect: "follow",
      headers: {
        "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36 hackathon-agent",
        accept: "image/*,*/*;q=0.5",
      },
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  const contentType = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() ?? "";
  if (!contentType.startsWith("image/")) return null;
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength < MIN_IMAGE_BYTES || buffer.byteLength > MAX_IMAGE_BYTES) return null;
  const fullKey = `${key}.${imageExtension(contentType)}`;
  await env.ASSETS_BUCKET.put(fullKey, buffer, { httpMetadata: { contentType } });
  return { url: `${getPublicBaseUrl(env)}/files/${fullKey}`, content_type: contentType, bytes: buffer.byteLength };
}

type LinkedPanda = Record<string, unknown>;

/** Normalize LinkedPanda's profile record into a compact enrichment object. */
function normalizeEnrichment(lp: LinkedPanda | null) {
  if (!lp) return { available: false as const };
  const first = (lp.firstName as string) ?? "";
  const last = (lp.lastName as string) ?? "";
  const links = extractLinks(lp.about);
  return {
    available: true as const,
    full_name: `${first} ${last}`.trim() || null,
    headline: (lp.headline as string) ?? null,
    current_title: (lp.title as string) ?? null,
    current_company: (lp.companyName as string) ?? null,
    company_domain: (lp.companyDomain as string) ?? null,
    location: (lp.location as string) ?? null,
    about: typeof lp.about === "string" ? (lp.about as string).slice(0, 1200) : null,
    skills: parseSkills(lp.topSkills),
    links: {
      linkedin: (lp.linkedinUrl as string) ?? null,
      website: links.website,
      github: links.github,
    },
    cover_image: (lp.coverUrl as string) ?? null,
  };
}

type StoredProfile = Record<string, unknown> & { fetched_at: string };

// -------------------------------------------------------------------------

export async function executeScrapeProfile(
  env: Env,
  input: ScrapeProfileInput,
): Promise<Record<string, unknown>> {
  if (!env.ASSETS_BUCKET) {
    return { error: "ASSETS_BUCKET (R2) is not configured.", code: "MISSING_BUCKET" };
  }
  const username = normalizeLinkedinUsername(input.recruit_linkedin_username);
  if (!username) {
    return { error: `"${input.recruit_linkedin_username}" is not a usable LinkedIn username.`, code: "INVALID_USERNAME" };
  }

  const base = getPublicBaseUrl(env);
  const cacheKey = `recruits/${username}/profile.json`;

  // R2-backed 24h cache: skip re-paying providers for a recently-scraped recruit.
  if (input.refresh !== true) {
    const cached = await env.ASSETS_BUCKET.get(cacheKey);
    if (cached) {
      const stored = await cached.json<StoredProfile>().catch(() => null);
      if (stored && Date.now() - Date.parse(stored.fetched_at) < CACHE_TTL_MS) {
        return { ...stored, cached: true, note: "Cached from an earlier scrape (refresh=true to re-scrape and re-pay)." };
      }
    }
  }

  const providersUsed: string[] = [];
  const warnings: string[] = [];
  let costEstimate = 0;

  // --- Step 1: LinkedPanda — photo + enrichment in one v2 call ---
  let lp: LinkedPanda | null = null;
  let linkedinAvatarUrl: string | null = null;
  try {
    lp = await zeroFetch<LinkedPanda>(env, {
      label: CAPABILITIES.linkedPanda.label,
      url: `${CAPABILITIES.linkedPanda.url}${encodeURIComponent(username)}`,
      method: "GET",
    });
    providersUsed.push("linkedpanda");
    costEstimate += CAPABILITIES.linkedPanda.price;
    linkedinAvatarUrl = (lp.avatarUrl as string) ?? null;
    const matchedName = `${(lp.firstName as string) ?? ""} ${(lp.lastName as string) ?? ""}`.trim();
    if (matchedName && !nameMatches(input.recruit_name, matchedName)) {
      warnings.push(`LinkedIn name "${matchedName}" does not clearly match "${input.recruit_name}" — verify the username.`);
    }
  } catch (error) {
    if (error instanceof ZeroError && error.code === "PAYMENT_NOT_CONFIGURED") {
      return { error: error.message, code: error.code };
    }
    warnings.push(`LinkedIn lookup failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  // --- Step 2: store the photo (LinkedIn only — no name-based fallbacks,
  // they routinely return a same-named stranger's face) ---
  let imageSource: "linkedin" | null = null;
  let storedImage: { url: string; content_type: string; bytes: number } | null = null;

  if (linkedinAvatarUrl) {
    storedImage = await storeImage(env, linkedinAvatarUrl, `recruits/${username}/linkedin`);
    if (storedImage) imageSource = "linkedin";
    else warnings.push("LinkedIn avatar URL did not download (may have expired).");
  } else if (lp) {
    warnings.push(
      "LinkedIn returned no profile photo — the recruit likely restricts photo visibility to logged-in members. "
        + "profile_image_url is null; ask the user for a photo if one is needed.",
    );
  }

  const enrichment = normalizeEnrichment(lp);

  if (providersUsed.length === 0) {
    return { error: "Every provider call failed — no data retrieved.", code: "ALL_PROVIDERS_FAILED", warnings };
  }

  // Persist the full raw provider payload to R2 and link it — keeps the
  // model-facing result compact while preserving everything.
  const rawKey = `recruits/${username}/raw.json`;
  await env.ASSETS_BUCKET.put(
    rawKey,
    JSON.stringify({ linkedpanda: lp, fetched_at: new Date().toISOString() }, null, 2),
    { httpMetadata: { contentType: "application/json" } },
  );

  const result: StoredProfile = {
    recruit_name: input.recruit_name,
    linkedin_username: username,
    profile_image_url: storedImage?.url ?? null,
    image_source: imageSource,
    image_content_type: storedImage?.content_type ?? null,
    enrichment,
    data_url: `${base}/files/${rawKey}`,
    providers_used: providersUsed,
    cost_estimate_usd: Number(costEstimate.toFixed(4)),
    fetched_at: new Date().toISOString(),
    ...(warnings.length > 0 ? { warnings } : {}),
  };

  await env.ASSETS_BUCKET.put(cacheKey, JSON.stringify(result), {
    httpMetadata: { contentType: "application/json" },
  });

  return { ...result, cached: false };
}
