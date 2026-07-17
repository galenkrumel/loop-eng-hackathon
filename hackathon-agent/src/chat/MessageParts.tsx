import { memo, useEffect, useRef, useState } from "react";
import type { UIMessage } from "ai";
import { getToolPartState } from "@cloudflare/ai-chat/react";
import { LB, FONTS } from "../lb";
import { ChatMarkdown } from "./markdown";
import { OrderForm } from "./OrderForm";
import { shimmerTextStyle } from "./theme";

type AnyPart = UIMessage["parts"][number] & Record<string, unknown>;

/* ----------------------------- reasoning ------------------------------- */

export function ReasoningBlock({ text, streaming }: { text: string; streaming: boolean }) {
  const [open, setOpen] = useState(false);
  const startedAtRef = useRef<number>(Date.now());
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    if (!streaming) return;
    const timer = setInterval(() => {
      setSeconds(Math.round((Date.now() - startedAtRef.current) / 1000));
    }, 1000);
    return () => clearInterval(timer);
  }, [streaming]);

  const label = streaming
    ? `Thinking${seconds >= 2 ? ` · ${seconds}s` : "…"}`
    : `Thought for ${Math.max(1, seconds)}s`;

  return (
    <div style={{ margin: "2px 0 10px" }}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 7,
          border: "none",
          background: "transparent",
          padding: 0,
          cursor: "pointer",
          fontSize: 12.5,
          fontWeight: 600,
          fontFamily: "inherit",
        }}
      >
        <span style={streaming ? shimmerTextStyle(LB.textDim) : { color: LB.textDim }}>{label}</span>
        <span style={{
          color: LB.textDim,
          fontSize: 10,
          transform: open ? "rotate(90deg)" : "none",
          transition: "transform 120ms ease",
        }}>
          ▶
        </span>
      </button>
      {(open || streaming) && text.trim() && (
        <div style={{
          marginTop: 7,
          padding: "4px 0 4px 14px",
          borderLeft: `2px solid ${LB.border}`,
          color: LB.textDim,
          fontSize: 13,
          lineHeight: 1.6,
          whiteSpace: "pre-wrap",
          overflowWrap: "anywhere",
          maxHeight: streaming ? 132 : 400,
          overflowY: "auto",
          display: "flex",
          flexDirection: "column-reverse",
        }}>
          <div>{text}</div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------- tools --------------------------------- */

function toolLabel(toolName: string, input: unknown, done: boolean): string {
  const record = input && typeof input === "object" && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {};
  switch (toolName) {
    case "Order_custom_product": {
      const title = typeof record.title === "string" && record.title.trim() ? ` “${record.title.trim()}”` : "";
      return `${done ? "Created" : "Creating"} a custom product${title}`;
    }
    case "Place_order":
      return done ? "Placed an order" : "Placing an order";
    case "Call_subagent": {
      const task = typeof record.task === "string" && record.task.trim()
        ? `: ${record.task.trim().slice(0, 60)}${record.task.trim().length > 60 ? "…" : ""}`
        : "";
      return `${done ? "Subagent finished" : "Delegating to subagent"}${task}`;
    }
    case "AnalyzeFile":
      return done ? "Analyzed a file" : "Analyzing a file";
    case "Generate_merch": {
      const recruit = typeof record.recruit_name === "string" && record.recruit_name.trim()
        ? ` for ${record.recruit_name.trim()}`
        : "";
      return `${done ? "Generated" : "Generating"} merch design${recruit}`;
    }
    case "Get_company_assets": {
      const company = typeof record.company_url === "string" && record.company_url.trim()
        ? ` from ${record.company_url.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "")}`
        : "";
      return `${done ? "Fetched" : "Fetching"} brand assets${company}`;
    }
    default:
      return toolName;
  }
}

function summarizeToolOutput(output: unknown): string | null {
  if (!output || typeof output !== "object") return null;
  const record = output as Record<string, unknown>;
  if (typeof record.error === "string") return record.error;
  if (typeof record.order_id === "string") return `order ${record.order_id}`;
  if (Array.isArray(record.assets) && typeof record.company === "string") {
    return `${record.assets.length} asset${record.assets.length === 1 ? "" : "s"}${record.cached === true ? " (cached)" : ""}`;
  }
  if (Array.isArray(record.mockup_images) && typeof record.product_id === "string") {
    return `${record.mockup_images.length} mockup${record.mockup_images.length === 1 ? "" : "s"}`;
  }
  if (typeof record.design_image === "string") return "design ready";
  if (typeof record.answer === "string") {
    const answer = record.answer.replace(/\s+/g, " ").trim();
    return answer.length > 70 ? `${answer.slice(0, 70)}…` : answer;
  }
  return null;
}

/** Image URLs a tool result wants rendered inline (Printify mockups,
 * scraped company assets, generated designs). */
function outputImages(output: unknown): string[] {
  if (!output || typeof output !== "object") return [];
  const record = output as Record<string, unknown>;
  const urls: string[] = [];
  if (typeof record.design_image === "string") urls.push(record.design_image);
  if (Array.isArray(record.mockup_images)) {
    urls.push(...record.mockup_images.filter((src): src is string => typeof src === "string"));
  }
  if (Array.isArray(record.assets)) {
    for (const asset of record.assets) {
      const url = (asset as Record<string, unknown>)?.url;
      if (typeof url === "string") urls.push(url);
    }
  }
  return urls.filter((src) => /^https?:\/\//.test(src)).slice(0, 8);
}

type OrderInfo = {
  productId: string;
  variants: Array<{ id: number; title: string }>;
  defaultVariantId: number | null;
};

function outputOrderInfo(output: unknown): OrderInfo | null {
  if (!output || typeof output !== "object") return null;
  const record = output as Record<string, unknown>;
  if (record.order_available !== true || typeof record.product_id !== "string") return null;
  const variants = Array.isArray(record.variants)
    ? record.variants.filter((entry): entry is { id: number; title: string } =>
      !!entry && typeof entry === "object"
      && typeof (entry as Record<string, unknown>).id === "number"
      && typeof (entry as Record<string, unknown>).title === "string")
    : [];
  return {
    productId: record.product_id,
    variants,
    defaultVariantId: typeof record.default_variant_id === "number" ? record.default_variant_id : null,
  };
}

function JsonPeek({ label, value }: { label: string; value: unknown }) {
  if (value === undefined) return null;
  let text: string;
  try {
    text = JSON.stringify(value, null, 2) ?? "";
  } catch {
    text = "<unserializable>";
  }
  if (text.length > 4000) text = `${text.slice(0, 4000)}\n… (${text.length} chars)`;
  return (
    <div style={{ marginTop: 6 }}>
      <div style={{
        fontFamily: FONTS.mono,
        fontSize: 10,
        color: LB.textDim,
        textTransform: "uppercase",
        letterSpacing: "0.06em",
        marginBottom: 3,
      }}>
        {label}
      </div>
      <pre style={{
        margin: 0,
        padding: "8px 10px",
        background: LB.surfaceAlt,
        border: `1px solid ${LB.border}`,
        borderRadius: 8,
        fontFamily: FONTS.mono,
        fontSize: 11.5,
        lineHeight: 1.5,
        maxHeight: 240,
        overflow: "auto",
        whiteSpace: "pre-wrap",
        overflowWrap: "anywhere",
      }}>
        {text}
      </pre>
    </div>
  );
}

export function ToolActivity({ part }: { part: AnyPart }) {
  const [expanded, setExpanded] = useState(false);
  const toolName = typeof part.type === "string" && part.type.startsWith("tool-")
    ? part.type.slice("tool-".length)
    : typeof part.toolName === "string" ? part.toolName : "tool";
  const state = getToolPartState(part as UIMessage["parts"][number]);
  const running = state === "loading" || state === "streaming";
  const failed = state === "error" || state === "denied"
    || (!!part.output && typeof part.output === "object" && typeof (part.output as Record<string, unknown>).error === "string");
  const done = !running;
  const summary = summarizeToolOutput(part.output);
  const images = outputImages(part.output);
  const orderInfo = outputOrderInfo(part.output);

  return (
    <div>
    <div style={{
      margin: "6px 0",
      border: `1px solid ${LB.border}`,
      borderRadius: 10,
      background: LB.surface,
      overflow: "hidden",
    }}>
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 9,
          width: "100%",
          padding: "8px 12px",
          border: "none",
          background: "transparent",
          cursor: "pointer",
          textAlign: "left",
          font: "inherit",
        }}
      >
        {running ? (
          <span style={{
            width: 13,
            height: 13,
            flexShrink: 0,
            borderRadius: 999,
            border: `2px solid ${LB.border}`,
            borderTopColor: LB.blue,
            animation: "lbChatSpin 700ms linear infinite",
          }} />
        ) : failed ? (
          <span style={{ color: LB.red, fontSize: 12, flexShrink: 0, fontWeight: 700 }}>✕</span>
        ) : (
          <span style={{ color: LB.green, fontSize: 12, flexShrink: 0, fontWeight: 700 }}>✓</span>
        )}
        <span style={{
          fontSize: 13,
          fontWeight: 600,
          color: running ? LB.textMid : LB.text,
          ...(running ? shimmerTextStyle(LB.textMid) : {}),
        }}>
          {toolLabel(toolName, part.input, done)}
        </span>
        {summary && (
          <span style={{
            fontFamily: FONTS.mono,
            fontSize: 11,
            color: failed ? LB.red : LB.textDim,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}>
            {summary}
          </span>
        )}
        <span style={{ marginLeft: "auto", color: LB.textDim, fontSize: 9, flexShrink: 0 }}>
          {expanded ? "▲" : "▼"}
        </span>
      </button>
      {expanded && (
        <div style={{ padding: "0 12px 10px", borderTop: `1px solid ${LB.surfaceAlt}` }}>
          <JsonPeek label="input" value={part.input} />
          <JsonPeek label={failed ? "error" : "output"} value={part.output ?? part.errorText} />
        </div>
      )}
    </div>
    {images.length > 0 && (
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, margin: "8px 0" }}>
        {images.map((src, index) => (
          <a key={index} href={src} target="_blank" rel="noreferrer noopener">
            <img
              src={src}
              alt={`mockup ${index + 1}`}
              style={{
                width: 150,
                height: 150,
                objectFit: "cover",
                borderRadius: 10,
                border: `1px solid ${LB.border}`,
                background: LB.surfaceAlt,
              }}
            />
          </a>
        ))}
      </div>
    )}
    {orderInfo && (
      <OrderForm
        productId={orderInfo.productId}
        variants={orderInfo.variants}
        defaultVariantId={orderInfo.defaultVariantId}
      />
    )}
    </div>
  );
}

/* ------------------------------ streaming text -------------------------- */

export const StreamingText = memo(function StreamingText({ text, withCursor }: { text: string; withCursor: boolean }) {
  return (
    <div style={{ position: "relative" }}>
      <ChatMarkdown text={text} />
      {withCursor && (
        <span style={{
          display: "inline-block",
          width: 7,
          height: 15,
          marginLeft: 2,
          borderRadius: 2,
          background: LB.text,
          verticalAlign: "-2px",
          animation: "lbChatBlink 1s steps(1) infinite",
        }} />
      )}
    </div>
  );
});
