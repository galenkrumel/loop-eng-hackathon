import { AIChatAgent } from "@cloudflare/ai-chat";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  convertToModelMessages,
  stepCountIs,
  streamText,
  type LanguageModelUsage,
  type StreamTextOnFinishCallback,
  type ToolSet,
  type UIMessage,
} from "ai";
import { SYSTEM_PROMPT } from "./prompt";
import { createHarnessTools, type HarnessContext } from "./tool";
import { transformDocumentFileParts } from "./files";
import {
  buildTailView,
  projectInputTokens,
  selectTailStartId,
  shouldCompact,
  summarizeUIHistory,
  type CompactionCheckpoint,
} from "./compaction";
import { getCompactionThresholdTokens } from "./types";
import {
  getAkashBaseUrl,
  getAkashModel,
  getModelContextTokens,
  MISSING_API_KEY_MESSAGE,
  type Env,
} from "./types";

const MAX_AGENT_STEPS = 10;
const TITLE_MAX_CHARS = 64;

/** Synced to connected clients via the Agents SDK state channel. */
export type ChatAgentState = {
  title: string | null;
  lastInputTokens: number | null;
  contextTokens: number | null;
  compactionCount: number;
  updatedAt: string | null;
};

type CompactionStateRow = {
  summary: string | null;
  tail_start_message_id: string | null;
  compaction_count: number;
  last_input_tokens: number | null;
};

/**
 * Render a stream/provider failure with enough detail to diagnose from the
 * chat UI: AI SDK call errors carry statusCode and the provider's raw
 * responseBody outside `message`, wrapped in a `cause` chain.
 */
export function describeStreamError(error: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && !seen.has(current); depth += 1) {
    seen.add(current);
    if (typeof current === "string") {
      if (current.trim() && !parts.includes(current.trim())) parts.push(current.trim());
      break;
    }
    if (typeof current !== "object") break;
    const record = current as Record<string, unknown>;
    const message = typeof record.message === "string" ? record.message.trim() : "";
    const statusCode = typeof record.statusCode === "number" ? record.statusCode : null;
    let segment = message;
    if (statusCode) segment = segment ? `${segment} (HTTP ${statusCode})` : `HTTP ${statusCode}`;
    if (segment && !parts.includes(segment)) parts.push(segment);
    const responseBody = typeof record.responseBody === "string" ? record.responseBody.trim() : "";
    if (responseBody) {
      const body = responseBody.length > 600 ? `${responseBody.slice(0, 600)}…` : responseBody;
      if (!parts.includes(body)) parts.push(body);
      break;
    }
    current = record.cause;
  }
  return parts.length > 0 ? parts.join(" — ") : "Agent chat failed";
}

function extractFirstUserText(messages: UIMessage[]): string {
  const first = messages.find((message) => message.role === "user");
  if (!first) return "";
  return first.parts.map((part) => (part.type === "text" ? part.text : "")).join("").trim();
}

/**
 * Resolve "attachment:last" / "attachment:<n>" against the conversation's
 * attached images (file parts with an image media type), in attachment
 * order. The model references attachments by handle instead of round-
 * tripping data URLs (Lightbase's media_code philosophy).
 */
export function resolveAttachmentRef(messages: UIMessage[], ref: string): string | null {
  const images: string[] = [];
  for (const message of messages) {
    if (message.role !== "user") continue;
    for (const part of message.parts) {
      const record = part as { type: string; mediaType?: string; url?: string };
      if (record.type === "file" && typeof record.url === "string"
        && (record.mediaType ?? "").startsWith("image/")) {
        images.push(record.url);
      }
    }
  }
  if (images.length === 0) return null;
  const match = ref.trim().toLowerCase().match(/^attachment:(last|\d+)$/);
  if (!match) return null;
  if (match[1] === "last") return images[images.length - 1];
  const index = Number.parseInt(match[1], 10);
  return index >= 1 && index <= images.length ? images[index - 1] : null;
}

/** Deterministic title from the opening message — no extra model call. */
export function titleFromText(text: string): string | null {
  const condensed = text.replace(/```[\s\S]*?```/g, " ").replace(/\s+/g, " ").trim();
  if (!condensed) return null;
  const words = condensed.split(" ").slice(0, 8).join(" ");
  const clipped = words.length > TITLE_MAX_CHARS ? `${words.slice(0, TITLE_MAX_CHARS - 1).trimEnd()}…` : words;
  return clipped || null;
}

/**
 * One Durable Object instance per chat conversation, named by chatId.
 *
 * The Agents SDK owns transport and transcript: messages persist in the DO's
 * SQLite, turns stream to clients over WebSocket as UIMessage chunks (with
 * replay on reconnect), and this class supplies the model loop — AkashML
 * provider wiring, the tool harness, and the state channel the header meters
 * read from.
 */
export class ChatAgent extends AIChatAgent<Env, ChatAgentState> {
  initialState: ChatAgentState = {
    title: null,
    lastInputTokens: null,
    contextTokens: null,
    compactionCount: 0,
    updatedAt: null,
  };

  messageConcurrency = "queue" as const;
  maxPersistedMessages = 200;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Compaction checkpoint lives OUTSIDE the transcript so the visible chat
    // never changes; only the model's view resets after a compaction.
    void this.sql`
      create table if not exists chat_compaction (
        id integer primary key check (id = 1),
        summary text,
        tail_start_message_id text,
        compaction_count integer not null default 0,
        last_input_tokens integer,
        updated_at text
      )
    `;
  }

  private loadCompactionState(): CompactionStateRow {
    const rows = this.sql<CompactionStateRow>`
      select summary, tail_start_message_id, compaction_count, last_input_tokens
      from chat_compaction where id = 1
    `;
    return rows.length > 0
      ? rows[0]
      : { summary: null, tail_start_message_id: null, compaction_count: 0, last_input_tokens: null };
  }

  private saveCheckpoint(summary: string, tailStartMessageId: string | null) {
    // Resets last_input_tokens: the old baseline described the pre-compaction
    // prompt, so the next projection re-estimates from the fresh view.
    void this.sql`
      insert into chat_compaction (id, summary, tail_start_message_id, compaction_count, last_input_tokens, updated_at)
      values (1, ${summary}, ${tailStartMessageId}, 1, null, datetime('now'))
      on conflict(id) do update set
        summary = excluded.summary,
        tail_start_message_id = excluded.tail_start_message_id,
        compaction_count = chat_compaction.compaction_count + 1,
        last_input_tokens = null,
        updated_at = datetime('now')
    `;
  }

  private persistLastInputTokens(inputTokens: number | null) {
    void this.sql`
      insert into chat_compaction (id, last_input_tokens, updated_at)
      values (1, ${inputTokens}, datetime('now'))
      on conflict(id) do update set
        last_input_tokens = excluded.last_input_tokens,
        updated_at = datetime('now')
    `;
  }

  async onChatMessage(onFinish: StreamTextOnFinishCallback<ToolSet>): Promise<Response> {
    const apiKey = this.env.AKASHML_API_KEY?.trim();
    if (!apiKey) {
      throw new Error(MISSING_API_KEY_MESSAGE);
    }

    const akash = createOpenAICompatible({
      name: "akashml",
      apiKey,
      baseURL: getAkashBaseUrl(this.env),
      includeUsage: true,
    });

    const harnessContext: HarnessContext = {
      env: this.env,
      resolveAttachment: (ref) => resolveAttachmentRef(this.messages, ref),
    };

    // ---- Compaction (between turns, invisible to the user) ----
    // Budgeting: AkashML only reports prompt_tokens AFTER a completion, so
    // the last turn's reported count is the baseline and the new user
    // message is estimated locally. Crossing the threshold summarizes the
    // model's current view via Qwen and resets it to [summary + tail].
    const state = this.loadCompactionState();
    let checkpoint: CompactionCheckpoint | null = state.summary
      ? {
          summary: state.summary,
          tail_start_message_id: state.tail_start_message_id,
          compaction_count: state.compaction_count,
        }
      : null;
    let view = buildTailView(this.messages, checkpoint);

    const lastUserMessage = [...this.messages].reverse().find((message) => message.role === "user");
    const projected = projectInputTokens(
      state.last_input_tokens,
      lastUserMessage ? [lastUserMessage] : [],
      view,
    );
    const threshold = getCompactionThresholdTokens(this.env);

    if (shouldCompact(projected, threshold) && view.length > 1) {
      try {
        const summary = await summarizeUIHistory(this.env, checkpoint?.summary ?? null, view);
        const tailStartId = selectTailStartId(this.messages);
        this.saveCheckpoint(summary, tailStartId);
        checkpoint = {
          summary,
          tail_start_message_id: tailStartId,
          compaction_count: state.compaction_count + 1,
        };
        view = buildTailView(this.messages, checkpoint);
        console.log(`[chat-agent] compacted projected=${projected} threshold=${threshold} count=${checkpoint.compaction_count} view_messages=${view.length}`);
      } catch (error) {
        // A failed summarizer must never block the turn — continue with the
        // uncompacted view and try again next turn.
        console.error(`[chat-agent] compaction_failed ${describeStreamError(error)}`);
      }
    }

    // The checkpoint summary rides the system prompt (not a user message):
    // safe for chat templates that reject non-alternating roles.
    const system = checkpoint
      ? `${SYSTEM_PROMPT}\n\n[CONTEXT CHECKPOINT — earlier conversation was compacted; this summary is authoritative for anything before the visible messages:]\n${checkpoint.summary}`
      : SYSTEM_PROMPT;

    // Attachments ride as /files/ R2 URLs: documents (PDF/CSV) become
    // extracted text, own-origin images inline as data URLs — all before
    // message conversion.
    const viewMessages = await transformDocumentFileParts(view, this.env);

    // Track the LAST step's usage: its prompt_tokens is the true context
    // size (totalUsage sums every step of a multi-tool turn and would
    // overcount the baseline ~3x on a 3-step turn).
    let lastStepUsage: LanguageModelUsage | null = null;

    const result = streamText({
      model: akash(getAkashModel(this.env)),
      system,
      messages: await convertToModelMessages(viewMessages),
      tools: createHarnessTools(harnessContext),
      stopWhen: stepCountIs(MAX_AGENT_STEPS),
      onStepFinish: ({ usage }) => {
        lastStepUsage = usage ?? lastStepUsage;
      },
      onError: ({ error }) => {
        console.error(`[chat-agent] stream_error ${describeStreamError(error)}`);
      },
      onFinish: async (event) => {
        const inputTokens = lastStepUsage?.inputTokens
          ?? event.totalUsage?.inputTokens
          ?? null;
        this.persistLastInputTokens(typeof inputTokens === "number" ? inputTokens : null);
        const firstUserText = extractFirstUserText(this.messages);
        this.setState({
          ...this.state,
          title: this.state.title ?? titleFromText(firstUserText),
          lastInputTokens: typeof inputTokens === "number" ? inputTokens : this.state.lastInputTokens,
          contextTokens: getModelContextTokens(this.env),
          compactionCount: checkpoint?.compaction_count ?? this.state.compactionCount,
          updatedAt: new Date().toISOString(),
        });
        await onFinish(event as Parameters<typeof onFinish>[0]);
      },
    });

    return result.toUIMessageStreamResponse({
      sendReasoning: true,
      onError: describeStreamError,
    });
  }
}
