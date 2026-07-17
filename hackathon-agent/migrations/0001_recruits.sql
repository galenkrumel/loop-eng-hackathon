-- Recruit swag pipeline. One row per recruit, keyed by display name
-- (case-insensitive) because the agent addresses recruits by name in
-- Edit_recruits/View_recruits. All columns except name are nullable: rows are
-- seeded name-only from a big list, then saturated field by field as the
-- agent churns (scrape -> enrichment/profile photo, generate -> design/
-- Printify product/mockups).
CREATE TABLE recruits (
  name TEXT PRIMARY KEY COLLATE NOCASE,
  -- Canonical LinkedIn profile URL (https://linkedin.com/in/<slug>).
  linkedin_url TEXT,
  -- Company the recruit is being courted for (drives brand assets/design).
  company TEXT,
  -- Stable R2-backed https URLs minted by this worker (/files/<key>).
  profile_image_url TEXT,
  design_image_url TEXT,
  -- Printify product created from the design, plus its shareable links.
  printify_product_id TEXT,
  printify_product_url TEXT,
  -- JSON array of Printify mockup image URLs ('[]' when none yet).
  mockup_images TEXT NOT NULL DEFAULT '[]',
  -- Raw JSON blob of whatever the scraper found (PDL enrichment: emails,
  -- title, company, location, links, skills, experience, education, ...).
  enrichment TEXT,
  -- Coarse agent-managed pipeline stage; saturation itself is derived from
  -- the NULL columns, this is for human-readable progress and filtering.
  status TEXT NOT NULL DEFAULT 'new'
    CHECK (status IN ('new', 'enriched', 'merch_created', 'ordered', 'failed')),
  -- Free-form agent notes (e.g. why a recruit is 'failed').
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_recruits_status ON recruits(status);
