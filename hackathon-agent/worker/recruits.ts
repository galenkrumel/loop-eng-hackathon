import { z } from "zod";
import type { Env } from "./types";

/**
 * Edit_recruits / View_recruits / Search_recruits — the agent's interface to
 * the RECRUITS_DB D1 database (recruit swag pipeline state). Lightbase-harness
 * shape rules: executors are shared verbatim between chat and MCP, errors
 * return as { error, code } results, and bulk calls return per-item results
 * plus a summary so partial failures are reported precisely, never summarized
 * away.
 *
 * The workflow these support: seed 500+ rows name-only with Edit_recruits,
 * then churn — View_recruits(filter:"unsaturated") to pick a batch, run
 * Scrape_profile / Generate_merch per recruit, Edit_recruits to save each
 * result — until View_recruits reports unsaturated: 0. Search_recruits
 * resolves fuzzy user-text names ("the sarah from google", "Jon Smyth") to
 * the EXACT stored names the other two tools key on.
 */

// D1 safety caps. The hard platform limits are 100 bound parameters per
// statement and ~1,000 statements per Worker invocation (each db.batch()
// entry counts). Every bulk array input is capped at 90 so one tool call
// stays comfortably inside both: an Edit batch is at most 90 statements
// (13 binds each), and a View names lookup fits ONE IN (...) statement
// (90 binds < 100). Bigger workloads chunk across calls — the descriptions
// say so, and the agent loop handles it.
const MAX_BULK_ITEMS = 90;
const MAX_EDIT_RECRUITS = MAX_BULK_ITEMS;
const MAX_VIEW_NAMES = MAX_BULK_ITEMS;
// Row-return LIMITs on single one-bind selects — context/payload bounds, not
// bound-parameter concerns, so they sit above the bulk cap.
const MAX_SCAN_LIMIT = 500;
// GET /api/recruits (dashboard) returns the whole table in one response;
// hackathon scale is ~500 rows, this cap just bounds the payload.
const MAX_LIST_ROWS = 2000;
const DEFAULT_SCAN_LIMIT = 50;
const NAME_IN_CHUNK = 90;
// Search: whole-table in-worker scoring (shop-swap's no-FTS fallback path) —
// one light D1 read of at most this many rows serves every query in the call.
const MAX_SEARCH_CANDIDATES = 6000;
const MAX_SEARCH_QUERIES = MAX_BULK_ITEMS;
const MAX_SEARCH_MATCHES = 25;
const DEFAULT_SEARCH_MATCHES = 5;
// Floor that cuts bigram noise between unrelated names (~8-15 points) while
// keeping genuine typo matches (a one-letter name typo scores ~90+).
const MIN_SEARCH_SCORE = 20;

export const RECRUIT_STATUSES = ["new", "enriched", "merch_created", "ordered", "failed"] as const;

/** Fields a recruit row needs before it counts as saturated (pipeline done
 * through merch creation; ordering is tracked by status, not saturation). */
const SATURATION_FIELDS = [
  "linkedin_url",
  "enrichment",
  "profile_image_url",
  "design_image_url",
  "printify_product_id",
  "mockup_images",
] as const;

const recruitName = z.string().trim().min(1).max(200);

const recruitPatchSchema = z.object({
  name: recruitName.describe("Recruit display name — the row key (case-insensitive)"),
  linkedin_url: z.string().trim().min(1).max(500).optional()
    .describe("LinkedIn profile URL or linkedin.com/in/<slug> vanity slug"),
  company: z.string().trim().min(1).max(200).optional(),
  profile_image_url: z.string().trim().min(1).max(1000).optional()
    .describe("Stable https URL of the recruit's photo (from Scrape_profile)"),
  design_image_url: z.string().trim().min(1).max(1000).optional()
    .describe("Stable https URL of the generated flat design (from Generate_merch)"),
  printify_product_id: z.string().trim().min(1).max(100).optional(),
  printify_product_url: z.string().trim().min(1).max(1000).optional(),
  mockup_images: z.array(z.string().trim().min(1).max(1000)).max(20).optional()
    .describe("Printify mockup image URLs; replaces the stored set"),
  enrichment: z.union([z.record(z.string(), z.unknown()), z.array(z.unknown()), z.string()]).optional()
    .describe("Scraped enrichment data (the Scrape_profile enrichment object, or any JSON)"),
  status: z.enum(RECRUIT_STATUSES).optional(),
  notes: z.string().trim().max(4000).optional(),
}).strict();

export const editRecruitsInputSchema = z.object({
  recruits: z.array(recruitPatchSchema).min(1).max(MAX_EDIT_RECRUITS)
    .describe("One entry per recruit; name-only entries just create/keep the row"),
});
export type EditRecruitsInput = z.infer<typeof editRecruitsInputSchema>;

export const searchRecruitsInputSchema = z.object({
  queries: z.array(z.string().trim().min(1).max(200)).min(1).max(MAX_SEARCH_QUERIES)
    .describe('Fuzzy fragments to resolve, one per recruit you are looking for — names with typos, partial names, companies, or LinkedIn slugs (e.g. ["Jon Smyth", "sarah google", "gracehopper"])'),
  status: z.enum(RECRUIT_STATUSES).optional()
    .describe("Only match recruits currently in this pipeline status"),
  limit: z.number().int().min(1).max(MAX_SEARCH_MATCHES).optional()
    .describe(`Max matches returned per query (default ${DEFAULT_SEARCH_MATCHES})`),
});
export type SearchRecruitsInput = z.infer<typeof searchRecruitsInputSchema>;

export const viewRecruitsInputSchema = z.object({
  names: z.array(recruitName).min(1).max(MAX_VIEW_NAMES).optional()
    .describe("Exact recruit names to fetch (case-insensitive). Omit to scan with filter/limit instead."),
  filter: z.enum(["all", "unsaturated", "saturated", ...RECRUIT_STATUSES]).optional()
    .describe("Scan filter when names is omitted (default all). 'unsaturated' = rows still missing pipeline fields."),
  limit: z.number().int().min(1).max(MAX_SCAN_LIMIT).optional()
    .describe(`Max rows for a scan (default ${DEFAULT_SCAN_LIMIT})`),
  include_enrichment: z.boolean().optional()
    .describe("true returns each row's full enrichment JSON (large); default is a has/hasn't flag"),
});
export type ViewRecruitsInput = z.infer<typeof viewRecruitsInputSchema>;

type RecruitRow = {
  name: string;
  linkedin_url: string | null;
  company: string | null;
  profile_image_url: string | null;
  design_image_url: string | null;
  printify_product_id: string | null;
  printify_product_url: string | null;
  mockup_images: string;
  enrichment: string | null;
  status: string;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

function requireDb(env: Env): D1Database {
  if (!env.RECRUITS_DB) {
    throw new Error("RECRUITS_DB (D1) is not configured — run the recruits migration and redeploy.");
  }
  return env.RECRUITS_DB;
}

/** Normalize a LinkedIn ref (full URL or bare slug) to a canonical URL. */
function canonicalLinkedinUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  const match = /linkedin\.com\/in\/([^/?#]+)/i.exec(trimmed);
  if (match) return `https://www.linkedin.com/in/${match[1]}`;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  // Bare vanity slug.
  if (/^[\w-]+$/.test(trimmed)) return `https://www.linkedin.com/in/${trimmed}`;
  return trimmed;
}

function parseJsonColumn(text: string | null): unknown {
  if (text == null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function missingFields(row: RecruitRow): string[] {
  return SATURATION_FIELDS.filter((field) => {
    const value = row[field];
    if (field === "mockup_images") {
      const parsed = parseJsonColumn(row.mockup_images);
      return !Array.isArray(parsed) || parsed.length === 0;
    }
    return value == null || value === "";
  });
}

function shapeRow(row: RecruitRow, includeEnrichment: boolean): Record<string, unknown> {
  const missing = missingFields(row);
  return {
    name: row.name,
    linkedin_url: row.linkedin_url,
    company: row.company,
    profile_image_url: row.profile_image_url,
    design_image_url: row.design_image_url,
    printify_product_id: row.printify_product_id,
    printify_product_url: row.printify_product_url,
    mockup_images: parseJsonColumn(row.mockup_images) ?? [],
    ...(includeEnrichment
      ? { enrichment: parseJsonColumn(row.enrichment) }
      : { has_enrichment: row.enrichment != null }),
    status: row.status,
    notes: row.notes,
    updated_at: row.updated_at,
    saturated: missing.length === 0,
    ...(missing.length > 0 ? { missing } : {}),
  };
}

/* -------------------------------- Edit_recruits ---------------------------- */

// Upsert semantics: only the fields a patch carries are written; omitted
// fields keep their stored values (coalesce against excluded NULLs). There is
// deliberately no way to null a field back out — the pipeline only ever adds
// data, and re-running a step overwrites with the fresh value.
const UPSERT_SQL = `
insert into recruits (
  name, linkedin_url, company, profile_image_url, design_image_url,
  printify_product_id, printify_product_url, mockup_images, enrichment, status, notes
) values (?, ?, ?, ?, ?, ?, ?, coalesce(?, '[]'), ?, coalesce(?, 'new'), ?)
on conflict(name) do update set
  linkedin_url = coalesce(excluded.linkedin_url, recruits.linkedin_url),
  company = coalesce(excluded.company, recruits.company),
  profile_image_url = coalesce(excluded.profile_image_url, recruits.profile_image_url),
  design_image_url = coalesce(excluded.design_image_url, recruits.design_image_url),
  printify_product_id = coalesce(excluded.printify_product_id, recruits.printify_product_id),
  printify_product_url = coalesce(excluded.printify_product_url, recruits.printify_product_url),
  mockup_images = case when ? is null then recruits.mockup_images else excluded.mockup_images end,
  enrichment = coalesce(excluded.enrichment, recruits.enrichment),
  status = case when ? is null then recruits.status else excluded.status end,
  notes = coalesce(excluded.notes, recruits.notes),
  updated_at = datetime('now')
`;

export async function executeEditRecruits(env: Env, input: EditRecruitsInput): Promise<Record<string, unknown>> {
  const db = requireDb(env);

  // Case-insensitive dedupe (the PK collates NOCASE): later patches win so
  // "seed row then patch it" inside one call behaves like two calls.
  const byKey = new Map<string, z.infer<typeof recruitPatchSchema>>();
  for (const patch of input.recruits) {
    const key = patch.name.toLowerCase();
    const prior = byKey.get(key);
    byKey.set(key, prior ? { ...prior, ...patch } : patch);
  }
  const patches = [...byKey.values()];

  const statements = patches.map((patch) => {
    const mockups = patch.mockup_images !== undefined ? JSON.stringify(patch.mockup_images) : null;
    const enrichment = patch.enrichment !== undefined
      ? (typeof patch.enrichment === "string" ? patch.enrichment : JSON.stringify(patch.enrichment))
      : null;
    return db.prepare(UPSERT_SQL).bind(
      patch.name,
      patch.linkedin_url !== undefined ? canonicalLinkedinUrl(patch.linkedin_url) : null,
      patch.company ?? null,
      patch.profile_image_url ?? null,
      patch.design_image_url ?? null,
      patch.printify_product_id ?? null,
      patch.printify_product_url ?? null,
      mockups,
      enrichment,
      patch.status ?? null,
      patch.notes ?? null,
      // CASE guards: distinguish "not sent" from a legitimate replacement.
      mockups,
      patch.status ?? null,
    );
  });

  // One transactional batch: all upserts commit or roll back together, and a
  // 500-row seed costs one D1 round trip instead of 500.
  let results: ItemResult[];
  try {
    const batchResults = await db.batch(statements);
    results = patches.map((patch, index) => ({
      name: patch.name,
      success: batchResults[index]?.success === true,
      ...(batchResults[index]?.success === true ? {} : { error: "Upsert failed" }),
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { error: `Recruit upsert batch failed (no rows written): ${message}`, code: "DB_BATCH_FAILED" };
  }

  const succeeded = results.filter((row) => row.success).length;
  return {
    summary: { total: results.length, succeeded, failed: results.length - succeeded },
    results,
  };
}

type ItemResult = { name: string; success: boolean; error?: string };

/* -------------------------------- View_recruits ---------------------------- */

async function saturationTotals(db: D1Database): Promise<{ total: number; saturated: number }> {
  const row = await db.prepare(
    `select count(*) as total,
            sum(
              case when linkedin_url is not null and enrichment is not null
                and profile_image_url is not null and design_image_url is not null
                and printify_product_id is not null
                and mockup_images is not null and mockup_images != '[]'
              then 1 else 0 end
            ) as saturated
     from recruits`,
  ).first<{ total: number; saturated: number | null }>();
  return { total: row?.total ?? 0, saturated: row?.saturated ?? 0 };
}

export async function executeViewRecruits(env: Env, input: ViewRecruitsInput): Promise<Record<string, unknown>> {
  const db = requireDb(env);
  const includeEnrichment = input.include_enrichment === true;
  const totals = await saturationTotals(db);

  if (input.names && input.names.length > 0) {
    // Exact lookup: every requested name gets an entry — a row or a per-item
    // not_found — so bulk callers never lose track of a recruit silently.
    const unique = [...new Map(input.names.map((name) => [name.toLowerCase(), name])).values()];
    const found = new Map<string, RecruitRow>();
    for (let index = 0; index < unique.length; index += NAME_IN_CHUNK) {
      const chunk = unique.slice(index, index + NAME_IN_CHUNK);
      const result = await db.prepare(
        `select * from recruits where name in (${chunk.map(() => "?").join(",")})`,
      ).bind(...chunk).all<RecruitRow>();
      for (const row of result.results ?? []) found.set(row.name.toLowerCase(), row);
    }
    const recruits = unique.map((name) => {
      const row = found.get(name.toLowerCase());
      return row
        ? shapeRow(row, includeEnrichment)
        : { name, error: "Recruit not found — Edit_recruits creates rows", code: "NOT_FOUND" };
    });
    return {
      summary: {
        requested: unique.length,
        found: found.size,
        not_found: unique.length - found.size,
        db_total: totals.total,
        db_saturated: totals.saturated,
        db_unsaturated: totals.total - totals.saturated,
      },
      recruits,
    };
  }

  // Scan mode: filtered page for "what's left to do" loops.
  const filter = input.filter ?? "all";
  const limit = input.limit ?? DEFAULT_SCAN_LIMIT;
  const saturatedPredicate =
    `linkedin_url is not null and enrichment is not null
     and profile_image_url is not null and design_image_url is not null
     and printify_product_id is not null
     and mockup_images is not null and mockup_images != '[]'`;
  let where = "";
  const params: string[] = [];
  if (filter === "unsaturated") where = `where not (${saturatedPredicate})`;
  else if (filter === "saturated") where = `where ${saturatedPredicate}`;
  else if (filter !== "all") {
    where = "where status = ?";
    params.push(filter);
  }
  const result = await db.prepare(
    `select * from recruits ${where} order by name asc limit ?`,
  ).bind(...params, limit).all<RecruitRow>();
  const rows = (result.results ?? []) as RecruitRow[];

  return {
    summary: {
      db_total: totals.total,
      db_saturated: totals.saturated,
      db_unsaturated: totals.total - totals.saturated,
      filter,
      returned: rows.length,
      ...(rows.length === limit ? { note: `Result capped at limit ${limit}; call again for more.` } : {}),
    },
    recruits: rows.map((row) => shapeRow(row, includeEnrichment)),
  };
}

/* ------------------------------- Search_recruits --------------------------- */

function tokenize(value: string): string[] {
  return value.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

/**
 * In-worker relevance score, adapted from the shop-swap harness's no-FTS
 * search path: exact match 200, substring 100, prefix +40, plus up to 60 for
 * query-token overlap (half credit for partial token containment).
 */
function scoreText(queryLower: string, queryTokens: string[], text: string): number {
  if (queryTokens.length === 0 || !text) return 0;
  const t = text.toLowerCase();
  let score = 0;
  if (t === queryLower) score += 200;
  else if (t.includes(queryLower)) score += 100;
  if (t.startsWith(queryLower)) score += 40;
  const textTokens = tokenize(text);
  const textTokenSet = new Set(textTokens);
  let present = 0;
  for (const qt of queryTokens) {
    if (textTokenSet.has(qt)) present += 1;
    else if (textTokens.some((tt) => tt.startsWith(qt) || tt.includes(qt))) present += 0.5;
  }
  score += (present / queryTokens.length) * 60;
  return score;
}

function bigrams(value: string): Set<string> {
  const out = new Set<string>();
  for (let index = 0; index < value.length - 1; index += 1) {
    out.add(value.slice(index, index + 2));
  }
  return out;
}

/**
 * Dice coefficient over character bigrams — the typo-tolerance layer the
 * token scorer lacks ("Jon Smyth" vs "John Smith" shares no full token, but
 * most bigrams). 0..1.
 */
function bigramSimilarity(a: string, b: string): number {
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
  const aBigrams = bigrams(a);
  const bBigrams = bigrams(b);
  let common = 0;
  for (const gram of aBigrams) if (bBigrams.has(gram)) common += 1;
  return (2 * common) / (aBigrams.size + bBigrams.size);
}

type SearchCandidate = {
  name: string;
  company: string | null;
  linkedin_url: string | null;
  status: string;
  saturated: number;
};

function linkedinSlug(url: string | null): string {
  if (!url) return "";
  const match = /linkedin\.com\/in\/([^/?#]+)/i.exec(url);
  return match ? match[1] : url;
}

/** Composite score: the stored name dominates; company and LinkedIn slug are
 * secondary signals (so "sarah google" finds Sarah-at-Google) at 0.4 weight. */
function scoreCandidate(queryLower: string, queryTokens: string[], row: SearchCandidate): number {
  const nameScore = scoreText(queryLower, queryTokens, row.name)
    + bigramSimilarity(queryLower, row.name.toLowerCase()) * 80;
  const secondary = Math.max(
    scoreText(queryLower, queryTokens, row.company ?? ""),
    scoreText(queryLower, queryTokens, linkedinSlug(row.linkedin_url)),
  );
  return nameScore + secondary * 0.4;
}

export async function executeSearchRecruits(env: Env, input: SearchRecruitsInput): Promise<Record<string, unknown>> {
  const db = requireDb(env);
  const limit = input.limit ?? DEFAULT_SEARCH_MATCHES;

  // One light whole-table read serves every query in the call; the recruits
  // table is bounded (hundreds of rows), so in-worker scoring beats N LIKE
  // round trips and stays typo-tolerant.
  const params: string[] = [];
  let where = "";
  if (input.status) {
    where = "where status = ?";
    params.push(input.status);
  }
  const result = await db.prepare(
    `select name, company, linkedin_url, status,
            case when linkedin_url is not null and enrichment is not null
              and profile_image_url is not null and design_image_url is not null
              and printify_product_id is not null
              and mockup_images is not null and mockup_images != '[]'
            then 1 else 0 end as saturated
     from recruits ${where} limit ${MAX_SEARCH_CANDIDATES}`,
  ).bind(...params).all<SearchCandidate>();
  const candidates = (result.results ?? []) as SearchCandidate[];

  const unmatched: string[] = [];
  const results = input.queries.map((query) => {
    const queryLower = query.trim().toLowerCase();
    const queryTokens = tokenize(query);
    const scored = candidates
      .map((row) => ({ row, score: Math.round(scoreCandidate(queryLower, queryTokens, row)) }))
      .filter((entry) => entry.score >= MIN_SEARCH_SCORE)
      .sort((a, b) => b.score - a.score || a.row.name.localeCompare(b.row.name));
    if (scored.length === 0) unmatched.push(query);
    return {
      query,
      match_count: scored.length,
      matches: scored.slice(0, limit).map((entry) => ({
        // The exact stored row key — pass it verbatim to View_recruits /
        // Edit_recruits.
        name: entry.row.name,
        company: entry.row.company,
        status: entry.row.status,
        saturated: entry.row.saturated === 1,
        score: entry.score,
      })),
    };
  });

  return {
    summary: {
      queries: input.queries.length,
      matched: input.queries.length - unmatched.length,
      unmatched: unmatched.length,
      ...(unmatched.length > 0
        ? { unmatched_queries: unmatched, note: "Unmatched recruits are not in the database — seed them with Edit_recruits if they should be." }
        : {}),
      candidates_scanned: candidates.length,
      ...(input.status ? { status: input.status } : {}),
    },
    results,
  };
}

/* ---------------------------- Dashboard REST layer ------------------------- */

/** GET /api/recruits — the whole table, enrichment included, newest first.
 * Backs the Recruits page; same row shaping as View_recruits. */
export async function executeListAllRecruits(env: Env): Promise<Record<string, unknown>> {
  const db = requireDb(env);
  const totals = await saturationTotals(db);
  const result = await db.prepare(
    `select * from recruits order by updated_at desc limit ?`,
  ).bind(MAX_LIST_ROWS).all<RecruitRow>();
  const rows = (result.results ?? []) as RecruitRow[];
  return {
    summary: {
      db_total: totals.total,
      db_saturated: totals.saturated,
      db_unsaturated: totals.total - totals.saturated,
      returned: rows.length,
      ...(rows.length === MAX_LIST_ROWS ? { note: `Capped at ${MAX_LIST_ROWS} rows.` } : {}),
    },
    recruits: rows.map((row) => ({ ...shapeRow(row, true), created_at: row.created_at })),
  };
}

/** DELETE /api/recruits?name= — dashboard-only; the agent tools deliberately
 * have no delete (the pipeline only adds data). */
export async function executeDeleteRecruit(env: Env, name: string): Promise<Record<string, unknown>> {
  const db = requireDb(env);
  const result = await db.prepare(`delete from recruits where name = ?`).bind(name).run();
  if ((result.meta?.changes ?? 0) === 0) {
    return { error: `No recruit named "${name}"`, code: "NOT_FOUND" };
  }
  return { deleted: name };
}
