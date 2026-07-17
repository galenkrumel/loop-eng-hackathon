// Client for the /api/recruits REST surface (worker/recruits.ts executors).

export const RECRUIT_STATUSES = ["new", "enriched", "merch_created", "ordered", "failed"] as const;
export type RecruitStatus = (typeof RECRUIT_STATUSES)[number];

/** Normalized Scrape_profile enrichment (worker/scrape-profile.ts). Rows the
 * agent filled by hand may hold arbitrary JSON instead — render defensively. */
export type Enrichment = {
  available?: boolean;
  full_name?: string | null;
  headline?: string | null;
  current_title?: string | null;
  current_company?: string | null;
  industry?: string | null;
  location?: string | null;
  emails?: string[];
  phones?: string[];
  links?: Record<string, string | null>;
  skills?: string[];
  experience?: { title?: string | null; company?: string | null; start?: string | null; end?: string | null }[];
  education?: { school?: string | null; degrees?: string[]; majors?: string[]; gpa?: number | null; end?: string | null }[];
} & Record<string, unknown>;

export type Recruit = {
  name: string;
  linkedin_url: string | null;
  company: string | null;
  profile_image_url: string | null;
  design_image_url: string | null;
  printify_product_id: string | null;
  printify_product_url: string | null;
  mockup_images: string[];
  enrichment: Enrichment | unknown[] | string | null;
  status: RecruitStatus;
  notes: string | null;
  created_at?: string;
  updated_at: string;
  saturated: boolean;
  missing?: string[];
};

export type RecruitsSummary = {
  db_total: number;
  db_saturated: number;
  db_unsaturated: number;
  returned: number;
};

/** Structured enrichment if this row has it, else null (string/array blobs
 * fall through to the raw JSON section only). */
export function structuredEnrichment(recruit: Recruit): Enrichment | null {
  const value = recruit.enrichment;
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Enrichment;
  return null;
}

async function parseOrThrow<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => null) as (T & { error?: string }) | null;
  if (!response.ok || payload == null || typeof payload.error === "string") {
    throw new Error(payload?.error ?? `Request failed (${response.status})`);
  }
  return payload;
}

export async function fetchRecruits(): Promise<{ summary: RecruitsSummary; recruits: Recruit[] }> {
  const payload = await parseOrThrow<{ summary: RecruitsSummary; recruits: Recruit[] }>(
    await fetch("/api/recruits"),
  );
  return {
    summary: payload.summary,
    // mockup_images survives as a string when the stored JSON is unparseable.
    recruits: payload.recruits.map((row) => ({
      ...row,
      mockup_images: Array.isArray(row.mockup_images) ? row.mockup_images : [],
    })),
  };
}

/** Patch one recruit (same upsert semantics as the agent's Edit_recruits:
 * only sent fields change, nothing can be nulled back out). */
export async function patchRecruit(
  name: string,
  patch: Partial<Pick<Recruit, "company" | "linkedin_url" | "status" | "notes">>,
): Promise<void> {
  const payload = await parseOrThrow<{ results: { name: string; success: boolean; error?: string }[] }>(
    await fetch("/api/recruits", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ recruits: [{ name, ...patch }] }),
    }),
  );
  const item = payload.results?.[0];
  if (!item?.success) throw new Error(item?.error ?? "Update failed");
}

export async function deleteRecruit(name: string): Promise<void> {
  await parseOrThrow(await fetch(`/api/recruits?name=${encodeURIComponent(name)}`, { method: "DELETE" }));
}
