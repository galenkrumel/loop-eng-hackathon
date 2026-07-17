import { routeAgentRequest } from "agents";
import { createMcpHandler } from "agents/mcp";
import { buildMcpServer } from "./mcp";
import { executePlaceOrder, placeOrderInputSchema } from "./printify";
import {
  editRecruitsInputSchema,
  executeDeleteRecruit,
  executeEditRecruits,
  executeListAllRecruits,
} from "./recruits";
import { getPublicBaseUrl, type Env } from "./types";

export { ChatAgent } from "./chat-agent";
export { CompanyAssets } from "./company-assets";

const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

/**
 * Chat attachment intake. Files upload here FIRST (raw body + x-filename
 * header) and land in R2; the chat message then carries only the returned
 * /files/ URL. Data URLs in messages blew the DO SQLite ~2MB row limit
 * (SQLITE_TOOBIG on persistMessages — the "large CSV crashes the chat" bug).
 */
async function handleUpload(request: Request, env: Env): Promise<Response> {
  if (request.method.toUpperCase() !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }
  const buffer = await request.arrayBuffer();
  if (buffer.byteLength === 0) return Response.json({ error: "Empty upload" }, { status: 400 });
  if (buffer.byteLength > MAX_UPLOAD_BYTES) {
    return Response.json({ error: "File is over the 15 MB limit" }, { status: 413 });
  }
  const contentType = request.headers.get("content-type")?.split(";")[0].trim().toLowerCase()
    || "application/octet-stream";
  const rawName = decodeURIComponent(request.headers.get("x-filename") ?? "file");
  const safeName = rawName.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80) || "file";
  const key = `uploads/${crypto.randomUUID()}-${safeName}`;
  await env.ASSETS_BUCKET.put(key, buffer, { httpMetadata: { contentType } });
  return Response.json({
    url: `${getPublicBaseUrl(env)}/files/${key}`,
    filename: rawName,
    media_type: contentType,
    size_bytes: buffer.byteLength,
  });
}

/** Serve R2-stored assets (company scrapes, generated designs) publicly —
 * these URLs are handed to Printify and rendered in chat/MCP clients.
 * Mounted at /files/* because /assets/* belongs to the Vite SPA bundle. */
async function handleServeAsset(request: Request, env: Env): Promise<Response> {
  if (request.method.toUpperCase() !== "GET") {
    return new Response("Method not allowed", { status: 405 });
  }
  const key = decodeURIComponent(new URL(request.url).pathname.replace(/^\/files\//, ""));
  if (!key || key.includes("..")) return new Response("Not found", { status: 404 });
  const object = await env.ASSETS_BUCKET.get(key);
  if (!object) return new Response("Not found", { status: 404 });
  return new Response(object.body, {
    headers: {
      "content-type": object.httpMetadata?.contentType ?? "application/octet-stream",
      "cache-control": "public, max-age=86400",
      "access-control-allow-origin": "*",
    },
  });
}

/** Backs the chat UI's order form: same executor as the Place_order tool. */
async function handleCreateOrder(request: Request, env: Env): Promise<Response> {
  if (request.method.toUpperCase() !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }
  const body = await request.json().catch(() => null);
  const parsed = placeOrderInputSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: `Invalid order: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}` },
      { status: 400 },
    );
  }
  try {
    const result = await executePlaceOrder(env, parsed.data);
    return Response.json(result, { status: typeof result.error === "string" ? 502 : 200 });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 502 },
    );
  }
}

/**
 * Recruits dashboard REST surface — same executors as the agent's
 * Edit_recruits/View_recruits tools, so the page and the agent can never
 * disagree about semantics. GET lists everything (enrichment included),
 * POST upserts patches, DELETE removes one row by name.
 */
async function handleRecruitsApi(request: Request, env: Env): Promise<Response> {
  const method = request.method.toUpperCase();
  try {
    if (method === "GET") {
      return Response.json(await executeListAllRecruits(env));
    }
    if (method === "POST") {
      const body = await request.json().catch(() => null);
      const parsed = editRecruitsInputSchema.safeParse(body);
      if (!parsed.success) {
        return Response.json(
          { error: `Invalid patch: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}` },
          { status: 400 },
        );
      }
      const result = await executeEditRecruits(env, parsed.data);
      return Response.json(result, { status: typeof result.error === "string" ? 502 : 200 });
    }
    if (method === "DELETE") {
      const name = new URL(request.url).searchParams.get("name")?.trim();
      if (!name) return Response.json({ error: "name query param is required" }, { status: 400 });
      const result = await executeDeleteRecruit(env, name);
      return Response.json(result, { status: result.code === "NOT_FOUND" ? 404 : 200 });
    }
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({ ok: true, worker: "hackathon-agent" });
    }

    if (url.pathname === "/api/orders") {
      return handleCreateOrder(request, env);
    }

    if (url.pathname === "/api/recruits") {
      return handleRecruitsApi(request, env);
    }

    if (url.pathname === "/api/uploads") {
      return handleUpload(request, env);
    }

    if (url.pathname.startsWith("/files/")) {
      return handleServeAsset(request, env);
    }

    // MCP front door: streamable HTTP, per-request server construction.
    // No OAuth for the hackathon — add @cloudflare/workers-oauth-provider
    // around this route when it needs to go public.
    if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) {
      return createMcpHandler(buildMcpServer(env), { route: "/mcp" })(request, env, ctx);
    }

    // Agents SDK transport: WebSocket chat connections + the SDK's HTTP
    // endpoints (get-messages etc.) under /agents/chat-agent/<chatId>.
    const agentResponse = await routeAgentRequest(request, env);
    if (agentResponse) return agentResponse;

    return new Response("Not found", { status: 404 });
  },
};
