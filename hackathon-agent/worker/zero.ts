import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactEvmScheme, toClientEvmSigner } from "@x402/evm";
import { privateKeyToAccount } from "viem/accounts";
import type { Env } from "./types";

/**
 * Zero (x402) payment layer for the tool harness.
 *
 * A deployed Cloudflare Worker can't shell out to the `zero` CLI (which signs
 * x402 payments with the user's Zero-managed wallet), so the worker pays the
 * same Zero-indexed capabilities directly: it wraps `fetch` so a 402 response
 * gets a signed EIP-3009 USDC authorization (Base) and an automatic retry.
 *
 * Protocol note (learned the hard way): Zero capabilities are on DIFFERENT
 * x402 versions. AnyAPI is x402 **v1** (network name "base"); LinkedPanda is
 * x402 **v2** (CAIP-2 "eip155:8453"). The old `x402-fetch` lib is v1-only and
 * can't parse a v2 challenge, so we use `@x402/fetch` (v2) and register the
 * Base scheme for BOTH protocol versions on one client — it negotiates per
 * challenge. (PDL/Minerva settle via MPP on Tempo with cross-chain bridging,
 * which only the Zero CLI's stack does — those are intentionally not used
 * here; enrichment comes from LinkedPanda instead.)
 *
 * Errors are THROWN and converted to { error, code } results by the executor's
 * runTool wrapper, matching the rest of the harness.
 */

export class ZeroError extends Error {
  code: string;
  status?: number;
  constructor(message: string, code: string, status?: number) {
    super(message);
    this.name = "ZeroError";
    this.code = code;
    this.status = status;
  }
}

const BASE_NETWORK = "eip155:8453"; // Base mainnet, CAIP-2

let cachedFetcher: ((input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) | null = null;
let cachedKey: string | null = null;

/** A fetch that transparently pays x402 challenges (v1 + v2 on Base), built
 * once per key. */
function getPayingFetch(env: Env): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  const key = env.X402_PRIVATE_KEY?.trim();
  if (!key) {
    throw new ZeroError(
      "X402_PRIVATE_KEY is not configured. Add a funded Base wallet key to .dev.vars, or "
        + "`wrangler secret put X402_PRIVATE_KEY` once deployed.",
      "PAYMENT_NOT_CONFIGURED",
    );
  }
  const normalized = key.startsWith("0x") ? key : `0x${key}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(normalized)) {
    throw new ZeroError("X402_PRIVATE_KEY is not a valid 32-byte hex private key.", "BAD_PAYMENT_KEY");
  }
  if (cachedFetcher && cachedKey === normalized) return cachedFetcher;

  const account = privateKeyToAccount(normalized as `0x${string}`);
  const signer = toClientEvmSigner(account);
  // Register the Base "exact" scheme; the client negotiates the protocol
  // version per challenge, so this one registration pays both v2 capabilities
  // (LinkedPanda) and v1 capabilities (AnyAPI) on Base.
  const client = new x402Client().register(BASE_NETWORK, new ExactEvmScheme(signer));
  cachedFetcher = wrapFetchWithPayment(globalThis.fetch, client) as typeof cachedFetcher;
  cachedKey = normalized;
  return cachedFetcher!;
}

export type ZeroFetchOptions = {
  url: string;
  method?: "GET" | "POST";
  body?: unknown;
  headers?: Record<string, string>;
  /** Label used in error messages / logs (the capability name). */
  label: string;
  /** Abort the request (including the pay-and-retry) after this long. */
  timeoutMs?: number;
};

/**
 * Call a Zero x402 capability and return its parsed JSON body. Pays
 * automatically on a 402. Throws ZeroError on payment/HTTP/parse failure.
 */
export async function zeroFetch<T = unknown>(env: Env, opts: ZeroFetchOptions): Promise<T> {
  const payingFetch = getPayingFetch(env);
  const method = opts.method ?? (opts.body !== undefined ? "POST" : "GET");
  const headers: Record<string, string> = { accept: "application/json", ...opts.headers };
  if (opts.body !== undefined) headers["content-type"] = "application/json";

  let response: Response;
  try {
    response = await payingFetch(opts.url, {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      ...(opts.timeoutMs ? { signal: AbortSignal.timeout(opts.timeoutMs) } : {}),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = /insufficient|balance|fund/i.test(message)
      ? "INSUFFICIENT_FUNDS"
      : /maximum|exceed|cap/i.test(message)
        ? "PAYMENT_CAP_EXCEEDED"
        : "PAYMENT_FAILED";
    throw new ZeroError(`${opts.label}: ${message}`, code);
  }

  const text = await response.text();
  if (!response.ok) {
    throw new ZeroError(
      `${opts.label} returned HTTP ${response.status}: ${text.slice(0, 300)}`,
      "CAPABILITY_HTTP_ERROR",
      response.status,
    );
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ZeroError(`${opts.label} returned non-JSON body: ${text.slice(0, 200)}`, "CAPABILITY_BAD_JSON");
  }
}

/**
 * The Zero capabilities Scrape_profile depends on. URLs, methods, and the
 * verified request shapes come from live testing on Zero (2026-07-17).
 * Settles as x402 v2 on Base.
 */
export const CAPABILITIES = {
  /** LinkedIn profile lookup by username — the 800x800 avatarUrl PLUS rich
   * profile fields (headline, title, company, location, about, skills).
   * x402 v2. ~$0.05. */
  linkedPanda: {
    label: "LinkedPanda LinkedIn Lookup",
    url: "https://api.linkedpanda.com/agent/v1/profiles/",
    price: 0.05,
  },
  /** Brand kit by domain — logo URL + brand color hexes. x402 v2 on Base,
   * ~$0.02. (Brand.dev's own Zero capability settles via MPP on Tempo, which
   * only the Zero CLI's payment stack performs — this is the worker-payable
   * equivalent for Get_company_assets.) POST { domain }. */
  brandAssets: {
    label: "StatePulse Brand Assets Lookup",
    url: "https://statepulse-api.hahavoid0.workers.dev/brand/assets",
    price: 0.02,
    timeoutMs: 90_000,
  },
} as const;
