import { generateText, type ModelMessage, type UIMessage } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  getAkashBaseUrl,
  getAkashModel,
  MISSING_API_KEY_MESSAGE,
  type Env,
} from "./types";

/**
 * Context compaction for the 262K-token Qwen window.
 *
 * AkashML reports token usage only AFTER a completion (usage.prompt_tokens,
 * aggregate per request), so budgeting works like Lightbase's: the last
 * turn's reported prompt_tokens is the ground-truth baseline, new content is
 * estimated locally (~4 bytes/token, flat rates for images), and when the
 * projection crosses the threshold (default 150K) the history is summarized
 * by Qwen and the MODEL's view resets to [summary + recent tail]. The
 * user-visible transcript is never touched — compaction is invisible except
 * for the ⊜ counter in the header.
 *
 * Both agent levels compact: the chat DO between turns (checkpoint persisted
 * in DO SQLite), and subagents between steps inside one run (prepareStep
 * rewrites the in-flight message array).
 */

export type CompactionCheckpoint = {
  summary: string;
  tail_start_message_id: string | null;
  compaction_count: number;
};

/* ------------------------------ estimation ------------------------------ */

const BYTES_PER_TOKEN = 4;
/** Vision tokens for one image, conservatively high for phone photos. */
const IMAGE_PART_TOKENS = 1500;
/** PDFs become extracted text (capped at 60K chars) at request time; the
 * stored file part is estimated at that cap's token cost. */
const PDF_PART_TOKENS = 15_000;
const MESSAGE_OVERHEAD_TOKENS = 4;

function textTokens(text: string): number {
  return Math.ceil(text.length / BYTES_PER_TOKEN);
}

function estimatePart(part: Record<string, unknown>): number {
  const type = typeof part.type === "string" ? part.type : "";
  if (type === "text" || type === "reasoning") {
    return textTokens(typeof part.text === "string" ? part.text : "");
  }
  if (type === "file") {
    const mediaType = typeof part.mediaType === "string" ? part.mediaType : "";
    // Documents inline as extracted text at request time; estimate at the
    // extraction cap's token cost.
    if (mediaType === "application/pdf" || mediaType === "text/csv") return PDF_PART_TOKENS;
    return IMAGE_PART_TOKENS;
  }
  if (type.startsWith("tool-") || type === "dynamic-tool") {
    let total = 0;
    try {
      total += textTokens(JSON.stringify(part.input ?? ""));
      total += textTokens(JSON.stringify(part.output ?? ""));
    } catch {
      total += 500;
    }
    return total;
  }
  return 0;
}

export function estimateUIMessageTokens(message: UIMessage): number {
  return MESSAGE_OVERHEAD_TOKENS + message.parts.reduce(
    (sum, part) => sum + estimatePart(part as Record<string, unknown>),
    0,
  );
}

export function estimateUIConversationTokens(messages: UIMessage[]): number {
  return messages.reduce((sum, message) => sum + estimateUIMessageTokens(message), 0);
}

export function estimateModelMessagesTokens(messages: ModelMessage[]): number {
  let total = 0;
  for (const message of messages) {
    total += MESSAGE_OVERHEAD_TOKENS;
    const content = message.content as unknown;
    if (typeof content === "string") {
      total += textTokens(content);
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      const record = part as Record<string, unknown>;
      const type = typeof record.type === "string" ? record.type : "";
      if (type === "text" || type === "reasoning") {
        total += textTokens(typeof record.text === "string" ? record.text : "");
      } else if (type === "image" || type === "file") {
        total += IMAGE_PART_TOKENS;
      } else if (type === "tool-call" || type === "tool-result") {
        try {
          total += textTokens(JSON.stringify(record.input ?? record.output ?? ""));
        } catch {
          total += 500;
        }
      }
    }
  }
  return total;
}

/**
 * Projected prompt size for the next request. The provider-reported
 * prompt_tokens from the LAST turn is authoritative for everything already
 * in context; only genuinely new messages are estimated. With no baseline
 * (fresh chat, or right after compaction), estimate the whole view.
 */
export function projectInputTokens(
  lastInputTokens: number | null,
  newMessages: UIMessage[],
  view: UIMessage[],
): number {
  if (typeof lastInputTokens === "number" && lastInputTokens > 0) {
    return lastInputTokens + estimateUIConversationTokens(newMessages);
  }
  return estimateUIConversationTokens(view);
}

export function shouldCompact(projectedTokens: number, thresholdTokens: number): boolean {
  return projectedTokens >= thresholdTokens;
}

/* ------------------------------ tail / view ----------------------------- */

const TAIL_MAX_TOKENS = 20_000;
const TAIL_KEEP_USER_TURNS = 3;

/**
 * Oldest user message whose suffix fits the tail budget (looking back at
 * most TAIL_KEEP_USER_TURNS user turns). Tails always start on a user
 * message so assistant/tool sequences never get split.
 */
export function selectTailStartId(transcript: UIMessage[]): string | null {
  const userIndexes: number[] = [];
  for (let index = transcript.length - 1; index >= 0 && userIndexes.length < TAIL_KEEP_USER_TURNS; index -= 1) {
    if (transcript[index].role === "user") userIndexes.push(index);
  }
  if (userIndexes.length === 0) return null;

  let chosen = userIndexes[0];
  for (const index of userIndexes) {
    const suffixTokens = estimateUIConversationTokens(transcript.slice(index));
    if (suffixTokens <= TAIL_MAX_TOKENS) chosen = index;
    else break;
  }
  return transcript[chosen].id;
}

/** The model's view of the transcript: everything (no checkpoint) or the
 * checkpoint tail. A tail boundary that aged out of the stored transcript
 * degrades to a freshly computed recent tail. */
export function buildTailView(transcript: UIMessage[], checkpoint: CompactionCheckpoint | null): UIMessage[] {
  if (!checkpoint) return transcript;
  if (checkpoint.tail_start_message_id) {
    const start = transcript.findIndex((message) => message.id === checkpoint.tail_start_message_id);
    if (start >= 0) return transcript.slice(start);
  }
  const fallbackId = selectTailStartId(transcript);
  if (fallbackId) {
    const start = transcript.findIndex((message) => message.id === fallbackId);
    if (start >= 0) return transcript.slice(start);
  }
  return transcript;
}

/* ------------------------------ summarization --------------------------- */

export const SUMMARIZATION_PROMPT = `You are compacting an agent conversation into a CONTEXT CHECKPOINT so the conversation can continue with less history. Write a dense summary (under 1200 tokens) that preserves, in order of importance:
1. The user's goals and standing instructions, and the overall workflow state.
2. Recruit names and per-recruit progress (which recruits are done, in flight, pending).
3. Concrete artifacts: Printify product ids, variant ids, order ids, mockup image URLs (keep the exact URLs for up to the 10 most recent products), addresses provided by the user.
4. Tool results that still matter, stated as facts. Errors only if unresolved.
5. What was about to happen next.
Output only the summary text — no preamble, no headers about being a summary.`;

const SUMMARY_MAX_OUTPUT_TOKENS = 2048;
const RENDER_TEXT_CAP = 4000;
const RENDER_TOOL_CAP = 1500;

function capText(text: string, cap: number): string {
  return text.length > cap ? `${text.slice(0, cap)}…[truncated]` : text;
}

export function renderUITranscript(messages: UIMessage[]): string {
  const lines: string[] = [];
  for (const message of messages) {
    const chunks: string[] = [];
    for (const part of message.parts) {
      const record = part as Record<string, unknown>;
      const type = typeof record.type === "string" ? record.type : "";
      if (type === "text") {
        chunks.push(capText(typeof record.text === "string" ? record.text : "", RENDER_TEXT_CAP));
      } else if (type === "file") {
        const mediaType = typeof record.mediaType === "string" ? record.mediaType : "";
        chunks.push(mediaType === "application/pdf"
          ? `[attached PDF: ${record.filename ?? "document.pdf"}]`
          : `[attached image: ${record.filename ?? "image"}]`);
      } else if (type.startsWith("tool-") || type === "dynamic-tool") {
        const name = type === "dynamic-tool" && typeof record.toolName === "string"
          ? record.toolName
          : type.slice("tool-".length);
        let input = "";
        let output = "";
        try {
          input = capText(JSON.stringify(record.input ?? {}), RENDER_TOOL_CAP);
          output = capText(JSON.stringify(record.output ?? record.errorText ?? ""), RENDER_TOOL_CAP);
        } catch {
          /* unserializable — leave blank */
        }
        chunks.push(`[tool ${name} input=${input} output=${output}]`);
      }
    }
    if (chunks.length > 0) lines.push(`${message.role.toUpperCase()}: ${chunks.join("\n")}`);
  }
  return lines.join("\n\n");
}

export function renderModelTranscript(messages: ModelMessage[]): string {
  const lines: string[] = [];
  for (const message of messages) {
    const content = message.content as unknown;
    if (typeof content === "string") {
      lines.push(`${message.role.toUpperCase()}: ${capText(content, RENDER_TEXT_CAP)}`);
      continue;
    }
    if (!Array.isArray(content)) continue;
    const chunks: string[] = [];
    for (const part of content) {
      const record = part as Record<string, unknown>;
      const type = typeof record.type === "string" ? record.type : "";
      if (type === "text") chunks.push(capText(typeof record.text === "string" ? record.text : "", RENDER_TEXT_CAP));
      else if (type === "image" || type === "file") chunks.push("[image]");
      else if (type === "tool-call") {
        try {
          chunks.push(`[call ${record.toolName} ${capText(JSON.stringify(record.input ?? {}), RENDER_TOOL_CAP)}]`);
        } catch { /* skip */ }
      } else if (type === "tool-result") {
        try {
          chunks.push(`[result ${record.toolName} ${capText(JSON.stringify(record.output ?? {}), RENDER_TOOL_CAP)}]`);
        } catch { /* skip */ }
      }
    }
    if (chunks.length > 0) lines.push(`${message.role.toUpperCase()}: ${chunks.join("\n")}`);
  }
  return lines.join("\n\n");
}

async function runSummarizer(env: Env, transcriptText: string, priorSummary: string | null): Promise<string> {
  const apiKey = env.AKASHML_API_KEY?.trim();
  if (!apiKey) throw new Error(MISSING_API_KEY_MESSAGE);
  const akash = createOpenAICompatible({ name: "akashml", apiKey, baseURL: getAkashBaseUrl(env) });

  const prompt = priorSummary
    ? `Previous checkpoint summary (fold it in — it covers even earlier history):\n${priorSummary}\n\nConversation since then:\n${transcriptText}`
    : `Conversation:\n${transcriptText}`;

  const result = await generateText({
    model: akash(getAkashModel(env)),
    system: SUMMARIZATION_PROMPT,
    prompt,
    maxOutputTokens: SUMMARY_MAX_OUTPUT_TOKENS,
  });
  const summary = result.text.trim();
  if (!summary) throw new Error("Summarizer returned no text");
  return summary;
}

export async function summarizeUIHistory(
  env: Env,
  priorSummary: string | null,
  messages: UIMessage[],
): Promise<string> {
  return runSummarizer(env, renderUITranscript(messages), priorSummary);
}

/* -------------------------- subagent compaction -------------------------- */

/**
 * Mid-run compaction for a subagent's tool loop: summarize everything so
 * far and restart the in-flight message array as ONE user message (task +
 * progress summary) — a clean boundary that can never split a tool call
 * from its result and never produces non-alternating roles.
 */
export async function compactModelHistory(env: Env, messages: ModelMessage[]): Promise<ModelMessage[]> {
  const first = messages.find((message) => message.role === "user");
  const task = typeof first?.content === "string"
    ? first.content
    : Array.isArray(first?.content)
      ? first.content
        .map((part) => (typeof (part as { text?: string }).text === "string" ? (part as { text: string }).text : ""))
        .join("\n")
      : "";
  const summary = await runSummarizer(env, renderModelTranscript(messages), null);
  return [
    {
      role: "user",
      content: `${task}\n\n[CONTEXT CHECKPOINT — your earlier steps were compacted to save context. Progress so far:]\n${summary}\n\nContinue from where the checkpoint leaves off and finish the task. Do not repeat completed work.`,
    },
  ];
}
