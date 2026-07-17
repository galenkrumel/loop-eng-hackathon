# hackathon-agent

Barebones clone of the Lightbase agent architecture:

- **Hosting**: one Cloudflare **Durable Object per chat** (`ChatAgent extends AIChatAgent`, Cloudflare Agents SDK). The SDK owns transport (WebSocket + reconnect replay) and transcript persistence (DO SQLite); the class supplies the model loop.
- **Model**: **AkashML** (`Qwen/Qwen3.6-35B-A3B` — tool calling + vision + reasoning) through `@ai-sdk/openai-compatible` + the Vercel AI SDK's `streamText()` tool loop.
- **Tool harness** (executors shared verbatim between chat and MCP; errors return as `{ error, code }` results, never thrown):
  - `Order_custom_product` — uploads a flat design to Printify, creates a product (default: Mug 11oz, `PRINTIFY_BLUEPRINT_ID` to change), returns mockup images + variants. Chat renders the mockups and an inline order form; MCP results embed the mockups as image content blocks.
  - `Place_order` — mails a created product to an address (also backs the chat form via `POST /api/orders`).
  - `Call_subagent` — delegates a self-contained task to a Qwen subagent running its own tool loop (all tools except itself).
  - `AnalyzeFile` — sends an image (vision) or PDF (worker-side text extraction via unpdf) to the model with a question.
  - `Get_company_assets` — scrapes a company homepage (HTMLRewriter: og-image, icons, logo-heuristic imgs) plus Clearbit/Google-favicon fallbacks; bytes stored in the `hackathon-agent-assets` R2 bucket, index in a per-domain `CompanyAssets` Durable Object (24h cache, `refresh: true` to re-scrape), served at `/files/<key>` — stable URLs usable as design images everywhere.
  - `Scrape_profile` — `(recruit_name, recruit_linkedin_username) → { profile_image_url, enrichment }`. Pays Zero (x402) capabilities directly from the worker (`worker/zero.ts`: `@x402/fetch` v2 client + `viem`, one funded Base key in `X402_PRIVATE_KEY`). One **LinkedPanda** lookup (~$0.05, x402 **v2**/`eip155:8453`) returns both the 800×800 LinkedIn photo and enrichment (headline, title, company, location, skills, and the website/GitHub parsed from the bio); if LinkedIn has no photo it falls back to an **AnyAPI Instagram** search (~$0.002, x402 **v1**). The one client registers the Base scheme and negotiates the protocol version per challenge. Photo bytes land in the R2 bucket and serve at `/files/<key>`; the raw provider JSON is stored alongside and linked as `data_url`. Cached per recruit for 24h (`refresh: true` to re-pay). Feeds `profile_image` into `Generate_merch`. Without `X402_PRIVATE_KEY` it returns `{ error, code: "PAYMENT_NOT_CONFIGURED" }` and the rest of the harness is unaffected. (PDL/Minerva enrichment settle via MPP on Tempo with cross-chain bridging that only the Zero CLI performs — not used from the worker.)
- **Files**: the web composer attaches images (downscaled client-side to ≤1600px JPEG) and PDFs; images reach the model natively, PDFs are text-extracted in the worker before message conversion. Tools reference chat-attached images as `attachment:last` / `attachment:<n>`. Over MCP, upload bytes as `data:` URIs to `AnalyzeFile` / `Order_custom_product`.
- **MCP**: all four tools over streamable-HTTP MCP at `/mcp` (per-request `McpServer` construction, no OAuth yet).
- **Compaction**: both agent levels self-compact at 150K of the 262K Qwen window (`COMPACTION_THRESHOLD_TOKENS`). Budgeting uses AkashML's post-completion `usage.prompt_tokens` as the baseline plus a local estimate of new content. The chat DO summarizes its history via Qwen and resets the MODEL's view to [summary-in-system-prompt + last 3 user turns] — checkpoint persisted in DO SQLite, visible transcript untouched (⊜ counter in the header). Subagents compact mid-run via `prepareStep`, rewriting the in-flight history to [task + progress summary].
- **Frontend**: near-pixel copy of the Lightbase chat workspace (sidebar, streaming thread, tool activity tickets, reasoning blocks, context meter, composer).

## Setup

```sh
npm install
cp .dev.vars.example .dev.vars   # then paste your AKASHML_API_KEY
npm run dev
```

- App: http://localhost:8080
- Worker (direct): http://localhost:8787 — `/health`, `/mcp`, `/agents/chat-agent/<chatId>`

`AKASHML_MODEL` defaults to `Qwen/Qwen3.6-35B-A3B` (override in `.dev.vars` or `wrangler.jsonc`; it must support tool calling, and vision for image features).

## Test the MCP endpoint

```sh
curl -s http://localhost:8787/mcp \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
```

Or point `npx @modelcontextprotocol/inspector` at `http://localhost:8787/mcp`.

## Deploy

```sh
npm run deploy        # vite build && wrangler deploy
npx wrangler secret put AKASHML_API_KEY
```

The worker serves the built SPA from its assets binding, so one deploy ships both. `/agents/*`, `/mcp`, and `/health` run worker-first; everything else is static.

## Layout

```
worker/
  index.ts       fetch router: /health, /mcp, routeAgentRequest(/agents/*)
  chat-agent.ts  ChatAgent DO — AIChatAgent subclass, streamText + tools + state channel
  tool.ts        harness assembly: schemas, subagent executor, AI SDK ToolSet
  printify.ts    Order_custom_product / Place_order executors (Printify API)
  files.ts       AnalyzeFile executor + chat-path PDF→text transform (unpdf)
  mcp.ts         McpServer registering the same executors (+ inline mockup images)
  prompt.ts      static system prompt
src/
  App.tsx        chat page shell (sidebar / header meters / session)
  chat/          useAgentSession (useAgent + useAgentChat), thread, composer, sidebar
```
