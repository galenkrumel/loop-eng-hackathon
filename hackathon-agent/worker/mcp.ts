import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  ANALYZE_FILE_DESCRIPTION,
  CALL_SUBAGENT_DESCRIPTION,
  callSubagentInputSchema,
  executeCallSubagent,
  NO_ATTACHMENT_RESOLVER,
  ORDER_CUSTOM_PRODUCT_DESCRIPTION,
  PLACE_ORDER_DESCRIPTION,
  type HarnessContext,
} from "./tool";
import {
  executeOrderCustomProduct,
  executePlaceOrder,
  orderCustomProductInputSchema,
  placeOrderInputSchema,
} from "./printify";
import { analyzeFileInputSchema, executeAnalyzeFile } from "./files";
import { executeGetCompanyAssets, getCompanyAssetsInputSchema } from "./company-assets";
import { executeScrapeProfile, scrapeProfileInputSchema } from "./scrape-profile";
import { executeGenerateMerch, generateMerchInputSchema } from "./image-gen";
import {
  EDIT_RECRUITS_DESCRIPTION,
  GENERATE_MERCH_DESCRIPTION,
  GET_COMPANY_ASSETS_DESCRIPTION,
  SCRAPE_PROFILE_DESCRIPTION,
  SEARCH_RECRUITS_DESCRIPTION,
  VIEW_RECRUITS_DESCRIPTION,
} from "./tool";
import {
  editRecruitsInputSchema,
  executeEditRecruits,
  executeSearchRecruits,
  executeViewRecruits,
  searchRecruitsInputSchema,
  viewRecruitsInputSchema,
} from "./recruits";
import type { Env } from "./types";

const SERVER_INSTRUCTIONS =
  "Hackathon recruiting-swag agent tools. Get_company_assets scrapes a company site's brand images into stable "
  + "URLs. Order_custom_product creates a Printify product from a flat design image "
  + "(https URL or data:image/...;base64 URI — attachment: refs are chat-only) and returns mockup images (also as "
  + "inline image content). Place_order mails a created product to an address. Call_subagent delegates a "
  + "self-contained task to a Qwen subagent with its own tool loop. Generate_merch renders a personalized "
  + "recruit design (art-directed palette/tagline + photo + name, QA-reviewed) and can create the Printify product "
  + "in the same call. AnalyzeFile sends an image or PDF (URL or "
  + "data: URI — the upload path for files like LinkedIn-profile-list PDFs) to the model with a question. "
  + "Edit_recruits bulk-upserts recruit rows (name-keyed; linkedin_url, R2 image links, Printify product/mockup "
  + "links, enrichment JSON, status) into the recruits D1 database, up to 90 per call; View_recruits reads rows "
  + "by names or scans by filter (unsaturated lists recruits still missing pipeline fields) — iterate until the "
  + "summary's db_unsaturated is 0. Search_recruits resolves fuzzy/misspelled recruit references (name, company, "
  + "or LinkedIn fragments, up to 90 per call) to the exact stored names the other recruit tools key on. "
  + "Tool errors come back as { error, code }: fix the call or report what is missing — don't retry identical input.";

const MAX_INLINE_MOCKUPS = 3;
const MAX_INLINE_IMAGE_BYTES = 2 * 1024 * 1024;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

/** Fetch mockup URLs and inline them as MCP image content blocks so clients
 * render the product previews directly (mirrors the "send images over MCP"
 * requirement — results carry pixels, not just URLs). */
async function inlineMockupImages(urls: string[]): Promise<Array<{ type: "image"; data: string; mimeType: string }>> {
  const blocks: Array<{ type: "image"; data: string; mimeType: string }> = [];
  for (const url of urls.slice(0, MAX_INLINE_MOCKUPS)) {
    try {
      const response = await fetch(url, { headers: { "user-agent": "hackathon-agent" } });
      if (!response.ok) continue;
      const buffer = await response.arrayBuffer();
      if (buffer.byteLength === 0 || buffer.byteLength > MAX_INLINE_IMAGE_BYTES) continue;
      const mimeType = response.headers.get("content-type")?.split(";")[0].trim() || "image/jpeg";
      // Raster only: MCP clients render png/jpeg/webp/gif blocks; svg/ico go
      // URL-only in the text payload.
      if (!/^image\/(png|jpe?g|webp|gif)$/.test(mimeType)) continue;
      blocks.push({ type: "image", data: bytesToBase64(new Uint8Array(buffer)), mimeType });
    } catch {
      // A dead mockup URL degrades to text-only output, never a failed call.
    }
  }
  return blocks;
}

/** Same contract as the chat harness's runTool: thrown errors become
 * { error, code } results, never protocol-level failures. */
async function safely(run: () => Promise<Record<string, unknown>>): Promise<Record<string, unknown>> {
  try {
    return await run();
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error), code: "TOOL_FAILED" };
  }
}

/** Image URLs a tool result carries, regardless of which tool produced it. */
function collectResultImageUrls(result: Record<string, unknown>): string[] {
  const urls: string[] = [];
  if (Array.isArray(result.mockup_images)) {
    urls.push(...result.mockup_images.filter((src): src is string => typeof src === "string"));
  }
  if (Array.isArray(result.assets)) {
    for (const asset of result.assets) {
      const url = (asset as Record<string, unknown>)?.url;
      if (typeof url === "string") urls.push(url);
    }
  }
  // Scrape_profile's recruit photo — inline it so MCP clients render the face.
  if (typeof result.profile_image_url === "string") urls.push(result.profile_image_url);
  // Generate_merch's flat design PNG.
  if (typeof result.design_image === "string") urls.push(result.design_image);
  return urls;
}

async function toToolResult(result: Record<string, unknown>) {
  const content: Array<
    { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
  > = [{ type: "text", text: JSON.stringify(result, null, 2) }];
  content.push(...await inlineMockupImages(collectResultImageUrls(result)));
  return { content, isError: typeof result.error === "string" };
}

/**
 * The MCP front door for the same tool harness the chat agent runs.
 * Per-request server construction (never a shared instance): the streamable
 * HTTP transport is stateless.
 */
export function buildMcpServer(env: Env): McpServer {
  const server = new McpServer(
    { name: "hackathon-agent", version: "0.2.0" },
    { instructions: SERVER_INSTRUCTIONS },
  );

  // MCP has no conversation, so attachment: refs never resolve here.
  const ctx: HarnessContext = { env, resolveAttachment: NO_ATTACHMENT_RESOLVER };

  server.registerTool(
    "Order_custom_product",
    {
      title: "Create a custom product",
      description: ORDER_CUSTOM_PRODUCT_DESCRIPTION,
      inputSchema: orderCustomProductInputSchema.shape,
    },
    async (input) => toToolResult(await safely(() =>
      executeOrderCustomProduct(env, orderCustomProductInputSchema.parse(input), ctx.resolveAttachment))),
  );

  server.registerTool(
    "Place_order",
    {
      title: "Order and mail a product",
      description: PLACE_ORDER_DESCRIPTION,
      inputSchema: placeOrderInputSchema.shape,
    },
    async (input) => toToolResult(await safely(() => executePlaceOrder(env, placeOrderInputSchema.parse(input)))),
  );

  server.registerTool(
    "Call_subagent",
    {
      title: "Delegate to a subagent",
      description: CALL_SUBAGENT_DESCRIPTION,
      inputSchema: callSubagentInputSchema.shape,
    },
    async (input) => toToolResult(await safely(() => executeCallSubagent(ctx, callSubagentInputSchema.parse(input)))),
  );

  server.registerTool(
    "Get_company_assets",
    {
      title: "Fetch company brand assets",
      description: GET_COMPANY_ASSETS_DESCRIPTION,
      inputSchema: getCompanyAssetsInputSchema.shape,
    },
    async (input) => toToolResult(await safely(() => executeGetCompanyAssets(env, getCompanyAssetsInputSchema.parse(input)))),
  );

  server.registerTool(
    "Generate_merch",
    {
      title: "Generate a personalized merch design",
      description: GENERATE_MERCH_DESCRIPTION,
      inputSchema: generateMerchInputSchema.shape,
    },
    async (input) => toToolResult(await safely(() =>
      executeGenerateMerch(env, generateMerchInputSchema.parse(input), ctx.resolveAttachment))),
  );

  server.registerTool(
    "AnalyzeFile",
    {
      title: "Analyze an image or PDF",
      description: ANALYZE_FILE_DESCRIPTION,
      inputSchema: analyzeFileInputSchema.shape,
    },
    async (input) => toToolResult(await safely(() => executeAnalyzeFile(env, analyzeFileInputSchema.parse(input)))),
  );

  server.registerTool(
    "Scrape_profile",
    {
      title: "Scrape a recruit's profile",
      description: SCRAPE_PROFILE_DESCRIPTION,
      inputSchema: scrapeProfileInputSchema.shape,
    },
    async (input) => toToolResult(await safely(() => executeScrapeProfile(env, scrapeProfileInputSchema.parse(input)))),
  );

  server.registerTool(
    "Edit_recruits",
    {
      title: "Bulk-upsert recruits",
      description: EDIT_RECRUITS_DESCRIPTION,
      inputSchema: editRecruitsInputSchema.shape,
    },
    async (input) => toToolResult(await safely(() => executeEditRecruits(env, editRecruitsInputSchema.parse(input)))),
  );

  server.registerTool(
    "View_recruits",
    {
      title: "View recruits & pipeline progress",
      description: VIEW_RECRUITS_DESCRIPTION,
      inputSchema: viewRecruitsInputSchema.shape,
    },
    async (input) => toToolResult(await safely(() => executeViewRecruits(env, viewRecruitsInputSchema.parse(input)))),
  );

  server.registerTool(
    "Search_recruits",
    {
      title: "Fuzzy-search recruits",
      description: SEARCH_RECRUITS_DESCRIPTION,
      inputSchema: searchRecruitsInputSchema.shape,
    },
    async (input) => toToolResult(await safely(() => executeSearchRecruits(env, searchRecruitsInputSchema.parse(input)))),
  );

  return server;
}
