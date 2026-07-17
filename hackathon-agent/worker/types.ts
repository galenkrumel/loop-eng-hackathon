export interface Env {
  ChatAgent: DurableObjectNamespace;
  CompanyAssets: DurableObjectNamespace;
  ASSETS: Fetcher;
  ASSETS_BUCKET: R2Bucket;
  /** Recruit pipeline state (Edit_recruits / View_recruits). */
  RECRUITS_DB: D1Database;
  PUBLIC_BASE_URL?: string;
  AKASHML_API_KEY?: string;
  AKASHML_BASE_URL?: string;
  AKASHML_MODEL?: string;
  MODEL_CONTEXT_TOKENS?: string;
  PRINTIFY_API_KEY?: string;
  PRINTIFY_SHOP_ID?: string;
  PRINTIFY_BLUEPRINT_ID?: string;
  COMPACTION_THRESHOLD_TOKENS?: string;
  /** Funded Base wallet private key used to pay Zero x402 capabilities
   * (Scrape_profile). 32-byte hex, with or without 0x. */
  X402_PRIVATE_KEY?: string;
  /** Hard per-call USDC ceiling for Zero payments (default 0.10). */
  ZERO_MAX_PAY_USDC?: string;
}

export const MISSING_API_KEY_MESSAGE =
  "AKASHML_API_KEY is not configured. Add it to .dev.vars locally (or `wrangler secret put AKASHML_API_KEY` once deployed).";

export function getAkashBaseUrl(env: Env): string {
  const configured = env.AKASHML_BASE_URL?.trim().replace(/\/+$/, "");
  return configured && configured.length > 0 ? configured : "https://api.akashml.com/v1";
}

export function getAkashModel(env: Env): string {
  const configured = env.AKASHML_MODEL?.trim();
  return configured && configured.length > 0 ? configured : "Qwen/Qwen3.6-35B-A3B";
}

export function getModelContextTokens(env: Env): number {
  const parsed = Number.parseInt(env.MODEL_CONTEXT_TOKENS ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 262_144;
}

/** Origin used to mint absolute /assets/ URLs for R2-stored images. */
export function getPublicBaseUrl(env: Env): string {
  const configured = env.PUBLIC_BASE_URL?.trim().replace(/\/+$/, "");
  return configured && configured.length > 0 ? configured : "https://hackathon-agent.maxzhang67.workers.dev";
}

/** Compact once the projected prompt crosses this (default 150K of the
 * 262K Qwen window). Env-overridable, mostly so tests can force it low. */
export function getCompactionThresholdTokens(env: Env): number {
  const parsed = Number.parseInt(env.COMPACTION_THRESHOLD_TOKENS ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 150_000;
}
