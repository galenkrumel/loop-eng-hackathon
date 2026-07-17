import { z } from "zod";
import { getPublicBaseUrl, type Env } from "./types";

/**
 * Printify integration behind the Order_custom_product / Place_order tools.
 *
 * Flow: upload the flat image → create a product on the default blueprint
 * (Mug 11oz, env-overridable) → return Printify's generated mockup images
 * plus the variant list. Ordering is a separate step (Place_order executor)
 * so the chat UI can collect a mailing address in a form first — the tool
 * result carries everything the form needs.
 */

const PRINTIFY_API = "https://api.printify.com/v1";
const DEFAULT_BLUEPRINT_ID = 68; // Mug 11oz — single variant, one print area
const MAX_MOCKUPS = 6;
const MAX_VARIANTS = 25;

export const orderCustomProductInputSchema = z.object({
  image: z.string().trim().min(1).max(12_000_000)
    .describe('The flat design image: an https:// URL, a data:image/...;base64 URI, or "attachment:last" / "attachment:<n>" to use an image the user attached in this chat'),
  title: z.string().trim().min(1).max(120).optional()
    .describe("Product title shown on the listing; defaults to \"Custom product\""),
});
export type OrderCustomProductInput = z.infer<typeof orderCustomProductInputSchema>;

export const placeOrderInputSchema = z.object({
  product_id: z.string().trim().min(1).max(64).describe("Product id returned by Order_custom_product"),
  variant_id: z.number().int().positive().optional().describe("Variant to order; defaults to the product's default variant"),
  quantity: z.number().int().min(1).max(20).optional().describe("How many to order (default 1)"),
  address: z.object({
    first_name: z.string().trim().min(1).max(60),
    last_name: z.string().trim().min(1).max(60),
    email: z.string().trim().email().max(120),
    phone: z.string().trim().max(30).optional(),
    country: z.string().trim().length(2).describe("2-letter country code, e.g. US"),
    region: z.string().trim().max(60).optional().describe("State/province, e.g. CA"),
    address1: z.string().trim().min(1).max(120),
    address2: z.string().trim().max(120).optional(),
    city: z.string().trim().min(1).max(80),
    zip: z.string().trim().min(1).max(20),
  }).describe("Where to mail the product"),
});
export type PlaceOrderInput = z.infer<typeof placeOrderInputSchema>;

type PrintifyRequestInit = {
  method?: string;
  body?: Record<string, unknown>;
};

async function printifyFetch(env: Env, path: string, init: PrintifyRequestInit = {}): Promise<unknown> {
  const apiKey = env.PRINTIFY_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("PRINTIFY_API_KEY is not configured.");
  }
  const response = await fetch(`${PRINTIFY_API}${path}`, {
    method: init.method ?? "GET",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      "user-agent": "hackathon-agent",
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const text = await response.text();
  let payload: unknown = null;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const detail = text.length > 500 ? `${text.slice(0, 500)}…` : text;
    throw new Error(`Printify ${init.method ?? "GET"} ${path} failed (HTTP ${response.status}): ${detail}`);
  }
  return payload;
}

async function getShopId(env: Env): Promise<number> {
  const configured = Number.parseInt(env.PRINTIFY_SHOP_ID ?? "", 10);
  if (Number.isFinite(configured) && configured > 0) return configured;
  const shops = await printifyFetch(env, "/shops.json") as Array<{ id: number }>;
  if (!Array.isArray(shops) || shops.length === 0 || typeof shops[0]?.id !== "number") {
    throw new Error("No Printify shop found for this API key.");
  }
  return shops[0].id;
}

function getBlueprintId(env: Env): number {
  const configured = Number.parseInt(env.PRINTIFY_BLUEPRINT_ID ?? "", 10);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_BLUEPRINT_ID;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

/** Our own /assets/ URLs (R2-backed) are read directly from the bucket and
 * uploaded as base64 contents — Printify can't fetch localhost in dev, and
 * this skips a public round-trip in prod too. */
async function resolveOwnAssetToBase64(env: Env, image: string): Promise<string | null> {
  const base = getPublicBaseUrl(env);
  const prefixes = [`${base}/files/`, "http://localhost:8787/files/"];
  const prefix = prefixes.find((candidate) => image.startsWith(candidate));
  if (!prefix || !env.ASSETS_BUCKET) return null;
  const key = decodeURIComponent(image.slice(prefix.length));
  const object = await env.ASSETS_BUCKET.get(key);
  if (!object) return null;
  return bytesToBase64(new Uint8Array(await object.arrayBuffer()));
}

/** Upload the design to Printify's media library; returns the image id. */
async function uploadDesignImage(env: Env, image: string): Promise<string> {
  const fileName = `agent-design-${Date.now()}.png`;
  let body: Record<string, unknown>;
  if (image.startsWith("data:")) {
    const comma = image.indexOf(",");
    if (comma < 0) throw new Error("Malformed data: URI for the design image.");
    body = { file_name: fileName, contents: image.slice(comma + 1) };
  } else {
    const ownAsset = await resolveOwnAssetToBase64(env, image);
    body = ownAsset
      ? { file_name: fileName, contents: ownAsset }
      : { file_name: fileName, url: image };
  }
  const uploaded = await printifyFetch(env, "/uploads/images.json", { method: "POST", body }) as { id?: string };
  if (!uploaded?.id) throw new Error("Printify image upload returned no id.");
  return uploaded.id;
}

type CatalogVariant = { id: number; title: string; placeholders: Array<{ position: string }> };

export async function executeOrderCustomProduct(
  env: Env,
  input: OrderCustomProductInput,
  resolveAttachment: (ref: string) => string | null,
): Promise<Record<string, unknown>> {
  // "attachment:last" / "attachment:<n>" resolve against chat-attached images
  // (unavailable over MCP — pass a URL or data URI there).
  let image = input.image.trim();
  if (/^attachment:/i.test(image)) {
    const resolved = resolveAttachment(image);
    if (!resolved) {
      return {
        error: `No chat attachment matches "${image}". Attach an image to the conversation, or pass an https:// URL / data:image URI.`,
        code: "ATTACHMENT_NOT_FOUND",
      };
    }
    image = resolved;
  }
  // Own /assets/ URLs are allowed even over http (local dev) — they're read
  // straight from R2 rather than fetched.
  const isOwnAsset = [`${getPublicBaseUrl(env)}/files/`, "http://localhost:8787/files/"]
    .some((prefix) => image.startsWith(prefix));
  if (!isOwnAsset && !/^https:\/\//i.test(image) && !/^data:image\//i.test(image)) {
    return {
      error: 'image must be an https:// URL, a data:image/...;base64 URI, or "attachment:last".',
      code: "INVALID_IMAGE",
    };
  }

  const shopId = await getShopId(env);
  const blueprintId = getBlueprintId(env);

  // First print provider + its variants, resolved at runtime so a blueprint
  // swap via env needs no code change.
  const providers = await printifyFetch(env, `/catalog/blueprints/${blueprintId}/print_providers.json`) as Array<{ id: number }>;
  if (!Array.isArray(providers) || providers.length === 0) {
    return { error: `Blueprint ${blueprintId} has no print providers.`, code: "NO_PRINT_PROVIDER" };
  }
  const providerId = providers[0].id;
  const catalog = await printifyFetch(
    env,
    `/catalog/blueprints/${blueprintId}/print_providers/${providerId}/variants.json`,
  ) as { variants?: CatalogVariant[] };
  const variants = (catalog.variants ?? []).slice(0, MAX_VARIANTS);
  if (variants.length === 0) {
    return { error: `Blueprint ${blueprintId} provider ${providerId} has no variants.`, code: "NO_VARIANTS" };
  }
  const position = variants[0].placeholders?.[0]?.position ?? "front";

  const imageId = await uploadDesignImage(env, image);

  const title = input.title?.trim() || "Custom product";
  const product = await printifyFetch(env, `/shops/${shopId}/products.json`, {
    method: "POST",
    body: {
      title,
      description: `${title} — created by the hackathon agent.`,
      blueprint_id: blueprintId,
      print_provider_id: providerId,
      variants: variants.map((variant, index) => ({
        id: variant.id,
        price: 1999,
        is_enabled: index < MAX_VARIANTS,
      })),
      print_areas: [
        {
          variant_ids: variants.map((variant) => variant.id),
          placeholders: [
            {
              position,
              images: [{ id: imageId, x: 0.5, y: 0.5, scale: 1, angle: 0 }],
            },
          ],
        },
      ],
    },
  }) as {
    id?: string;
    title?: string;
    images?: Array<{ src: string; is_default?: boolean }>;
    variants?: Array<{ id: number; title: string; is_enabled?: boolean }>;
  };

  if (!product?.id) {
    return { error: "Printify product creation returned no id.", code: "PRODUCT_CREATE_FAILED" };
  }

  const mockups = [...(product.images ?? [])]
    .sort((left, right) => Number(right.is_default ?? false) - Number(left.is_default ?? false))
    .map((entry) => entry.src)
    .filter((src): src is string => typeof src === "string" && src.length > 0)
    .slice(0, MAX_MOCKUPS);
  const enabledVariants = (product.variants ?? [])
    .filter((variant) => variant.is_enabled !== false)
    .map((variant) => ({ id: variant.id, title: variant.title }));

  return {
    product_id: product.id,
    title: product.title ?? title,
    mockup_images: mockups,
    variants: enabledVariants,
    default_variant_id: enabledVariants[0]?.id ?? variants[0].id,
    // Signal for the chat UI to render the order form; over MCP, follow up
    // with the Place_order tool instead.
    order_available: true,
    note: "Mockups above are Printify's generated reference images. To ship one, use the order form (chat) or the Place_order tool (MCP) with a mailing address.",
  };
}

export async function executePlaceOrder(env: Env, input: PlaceOrderInput): Promise<Record<string, unknown>> {
  const shopId = await getShopId(env);

  let variantId = input.variant_id;
  if (!variantId) {
    const product = await printifyFetch(env, `/shops/${shopId}/products/${input.product_id}.json`) as {
      variants?: Array<{ id: number; is_enabled?: boolean }>;
    };
    variantId = (product.variants ?? []).find((variant) => variant.is_enabled !== false)?.id
      ?? (product.variants ?? [])[0]?.id;
    if (!variantId) {
      return { error: `Product ${input.product_id} has no orderable variants.`, code: "NO_VARIANTS" };
    }
  }

  const address = input.address;
  const order = await printifyFetch(env, `/shops/${shopId}/orders.json`, {
    method: "POST",
    body: {
      external_id: `agent-${Date.now()}`,
      line_items: [
        { product_id: input.product_id, variant_id: variantId, quantity: input.quantity ?? 1 },
      ],
      shipping_method: 1,
      send_shipping_notification: false,
      address_to: {
        first_name: address.first_name,
        last_name: address.last_name,
        email: address.email,
        phone: address.phone ?? "",
        country: address.country.toUpperCase(),
        region: address.region ?? "",
        address1: address.address1,
        address2: address.address2 ?? "",
        city: address.city,
        zip: address.zip,
      },
    },
  }) as { id?: string };

  if (!order?.id) {
    return { error: "Printify order creation returned no id.", code: "ORDER_CREATE_FAILED" };
  }
  return {
    order_id: order.id,
    product_id: input.product_id,
    variant_id: variantId,
    quantity: input.quantity ?? 1,
    status: "created",
    note: "Order created in Printify (draft/on-hold until submitted for production in the Printify dashboard, unless auto-approval is enabled).",
  };
}
