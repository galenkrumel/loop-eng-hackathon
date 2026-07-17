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

/* ----------------------- multi-product merch catalog ---------------------- */

/**
 * Product catalog ported from the jersey-studio branch (Consti's
 * jersey-app/printify_client.py): tee is the multi-position jersey flow
 * (front/back/sleeves/neck), hat is a DTF front panel, mug is the
 * sublimation wrap. Providers are Printify Choice (99) like the reference
 * app, with a runtime fallback to whatever provider actually stocks the
 * blueprint.
 */
export type MerchProductType = "tee" | "hat" | "mug";

export type MerchProductConfig = {
  label: string;
  blueprintId: number;
  printProviderId: number;
  /** Print positions in preferred order; must match Printify placeholder names. */
  positions: readonly string[];
  hasColor: boolean;
  /** Variant sizes to enable; null enables every size the provider offers. */
  sizes: readonly string[] | null;
  priceCents: number;
  fallbackColors: readonly string[];
};

export const MERCH_PRODUCTS: Record<MerchProductType, MerchProductConfig> = {
  tee: {
    label: "T-shirt",
    // Bella+Canvas 3001 Unisex Jersey Short Sleeve Tee
    blueprintId: 12,
    printProviderId: 99,
    positions: ["front", "back", "left_sleeve", "right_sleeve", "neck"],
    hasColor: true,
    sizes: ["S", "M", "L", "XL", "2XL"],
    priceCents: 2499,
    fallbackColors: ["Black", "White", "Navy", "True Royal", "Red"],
  },
  hat: {
    label: "Hat",
    // OTTO Cap Low Profile Baseball Cap — DTF front
    blueprintId: 1108,
    printProviderId: 99,
    positions: ["front"],
    hasColor: true,
    sizes: null,
    priceCents: 2499,
    fallbackColors: ["Black", "Dark Green", "Dark Navy", "Khaki", "Red", "Royal", "White"],
  },
  mug: {
    label: "Mug",
    // Ceramic Mug 11oz/15oz — dye-sublimation wrap
    blueprintId: 478,
    printProviderId: 99,
    positions: ["front"],
    hasColor: false,
    sizes: ["11oz", "15oz"],
    priceCents: 1999,
    fallbackColors: [],
  },
};

type MerchVariant = {
  id: number;
  title?: string;
  options?: { color?: string; size?: string };
  placeholders?: Array<{ position?: string; width?: number; height?: number }>;
};

export type MerchCatalog = {
  providerId: number;
  variants: MerchVariant[];
  colors: string[];
};

async function fetchVariantsFor(env: Env, blueprintId: number, providerId: number): Promise<MerchVariant[]> {
  const catalog = await printifyFetch(
    env,
    `/catalog/blueprints/${blueprintId}/print_providers/${providerId}/variants.json`,
  ) as { variants?: MerchVariant[] };
  return Array.isArray(catalog.variants) ? catalog.variants : [];
}

function variantColors(variants: MerchVariant[]): string[] {
  const seen = new Set<string>();
  for (const variant of variants) {
    const color = variant.options?.color;
    if (typeof color === "string" && color) seen.add(color);
  }
  return [...seen].sort();
}

/** Variants + blank colors for a product, falling back past a dead provider. */
export async function fetchMerchCatalog(env: Env, productType: MerchProductType): Promise<MerchCatalog> {
  const config = MERCH_PRODUCTS[productType];
  let providerId = config.printProviderId;
  let variants: MerchVariant[] = [];
  try {
    variants = await fetchVariantsFor(env, config.blueprintId, providerId);
  } catch {
    variants = [];
  }
  if (variants.length === 0) {
    const providers = await printifyFetch(
      env,
      `/catalog/blueprints/${config.blueprintId}/print_providers.json`,
    ) as Array<{ id: number }>;
    for (const candidate of providers ?? []) {
      if (!candidate?.id || candidate.id === config.printProviderId) continue;
      try {
        const alternative = await fetchVariantsFor(env, config.blueprintId, candidate.id);
        if (alternative.length > 0) {
          providerId = candidate.id;
          variants = alternative;
          break;
        }
      } catch {
        continue;
      }
    }
  }
  if (variants.length === 0) {
    throw new Error(`No Printify variants found for ${config.label} (blueprint ${config.blueprintId}).`);
  }
  return { providerId, variants, colors: variantColors(variants) };
}

/** Map a requested blank color onto an exact catalog color name. */
export function resolveBlankColor(requested: string | null | undefined, allowed: string[]): string {
  if (allowed.length === 0) throw new Error("No blank colors available for this blueprint.");
  const query = requested?.trim().toLowerCase();
  if (query) {
    const exact = allowed.find((color) => color.toLowerCase() === query);
    if (exact) return exact;
    const soft = allowed.filter((color) =>
      color.toLowerCase().includes(query) || query.includes(color.toLowerCase()));
    if (soft.length > 0) return soft.reduce((best, color) => (color.length > best.length ? color : best));
  }
  for (const preferred of ["Black", "Navy", "White", "Dark Navy", "Royal"]) {
    if (allowed.includes(preferred)) return preferred;
  }
  return allowed[0];
}

function selectMerchVariants(
  variants: MerchVariant[],
  config: MerchProductConfig,
  color: string | null,
): MerchVariant[] {
  const sizeSet = config.sizes ? new Set(config.sizes) : null;
  let selected = variants.filter((variant) => {
    const options = variant.options ?? {};
    if (color && options.color !== color) return false;
    if (sizeSet && typeof options.size === "string" && !sizeSet.has(options.size)) return false;
    return true;
  });
  // Color was forced but the size filter emptied the set — keep the color, any size.
  if (selected.length === 0 && color) {
    selected = variants.filter((variant) => variant.options?.color === color);
  }
  if (selected.length === 0) selected = variants;
  return selected.slice(0, MAX_VARIANTS);
}

/** Positions every selected variant supports (intersection). */
function supportedPositions(variants: MerchVariant[]): Set<string> {
  const sets = variants
    .map((variant) => new Set(
      (variant.placeholders ?? [])
        .map((placeholder) => placeholder.position)
        .filter((position): position is string => typeof position === "string" && position.length > 0),
    ))
    .filter((set) => set.size > 0);
  if (sets.length === 0) return new Set();
  return sets.reduce((shared, set) => new Set([...shared].filter((position) => set.has(position))));
}

export type CreateMerchProductArgs = {
  productType: MerchProductType;
  title: string;
  description?: string;
  /** Print-position → image source (https URL / data URI / own asset URL).
   * The same source on several positions is uploaded once. */
  imagesByPosition: Record<string, string>;
  blankColor?: string | null;
};

/**
 * Multi-position product creation, ported from upload_and_create_draft /
 * create_product in Consti's printify_client.py: pick variants by blank
 * color + size, place each layer on its print position, dedupe uploads.
 */
export async function createMerchProduct(env: Env, args: CreateMerchProductArgs): Promise<Record<string, unknown>> {
  const config = MERCH_PRODUCTS[args.productType];
  const shopId = await getShopId(env);
  const { providerId, variants: allVariants, colors } = await fetchMerchCatalog(env, args.productType);

  let chosenColor: string | null = null;
  if (config.hasColor) {
    const allowed = colors.length > 0 ? colors : [...config.fallbackColors];
    chosenColor = resolveBlankColor(args.blankColor, allowed);
  }
  const variants = selectMerchVariants(allVariants, config, chosenColor);
  const supported = supportedPositions(variants);

  const uploadIdBySource = new Map<string, string>();
  const placeholders: Array<Record<string, unknown>> = [];
  const usedPositions: string[] = [];
  for (const position of config.positions) {
    const source = args.imagesByPosition[position];
    if (!source || (supported.size > 0 && !supported.has(position))) continue;
    let imageId = uploadIdBySource.get(source);
    if (!imageId) {
      imageId = await uploadDesignImage(env, source);
      uploadIdBySource.set(source, imageId);
    }
    placeholders.push({
      position,
      images: [{ id: imageId, x: 0.5, y: 0.5, scale: 1, angle: 0 }],
    });
    usedPositions.push(position);
  }
  if (placeholders.length === 0) {
    throw new Error(
      `None of the provided print positions are supported by this provider `
      + `(provided: ${Object.keys(args.imagesByPosition).sort().join(", ")}; `
      + `supported: ${[...supported].sort().join(", ") || "unknown"}).`,
    );
  }

  const variantIds = variants.map((variant) => variant.id);
  const product = await printifyFetch(env, `/shops/${shopId}/products.json`, {
    method: "POST",
    body: {
      title: args.title.slice(0, 200),
      description: (args.description ?? `${args.title} — created by the hackathon agent.`).slice(0, 2000),
      blueprint_id: config.blueprintId,
      print_provider_id: providerId,
      variants: variantIds.map((id) => ({ id, price: config.priceCents, is_enabled: true })),
      print_areas: [{ variant_ids: variantIds, placeholders }],
    },
  }) as {
    id?: string;
    title?: string;
    images?: Array<{ src: string; is_default?: boolean }>;
    variants?: Array<{ id: number; title: string; is_enabled?: boolean }>;
  };
  if (!product?.id) throw new Error("Printify product creation returned no id.");

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
    title: product.title ?? args.title,
    product_type: args.productType,
    blueprint_id: config.blueprintId,
    print_provider_id: providerId,
    blank_color: chosenColor,
    positions: usedPositions,
    mockup_images: mockups,
    variants: enabledVariants,
    default_variant_id: enabledVariants[0]?.id ?? variantIds[0],
    order_available: true,
    printify_product_url: `https://printify.com/app/product-details/${product.id}`,
    note: "Mockups above are Printify's generated reference images. To ship one, use the order form (chat) or the Place_order tool (MCP) with a mailing address.",
  };
}

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
    printify_product_url: `https://printify.com/app/product-details/${product.id}`,
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
