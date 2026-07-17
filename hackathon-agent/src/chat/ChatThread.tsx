import { useEffect, useRef, useState } from "react";
import type { UIMessage } from "ai";
import { LB, FONTS } from "../lb";
import { ReasoningBlock, StreamingText, ToolActivity } from "./MessageParts";
import { ThinkingIndicator } from "./ThinkingIndicator";

type AnyPart = UIMessage["parts"][number] & Record<string, unknown>;

function UserMessage({ message }: { message: UIMessage }) {
  const text = message.parts
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("")
    .trim();
  const fileParts = (message.parts as AnyPart[]).filter(
    (part) => part.type === "file" && typeof part.url === "string",
  );
  const images = fileParts.filter(
    (part) => typeof part.mediaType !== "string" || part.mediaType.startsWith("image/"),
  );
  const documents = fileParts.filter(
    (part) => part.mediaType === "application/pdf" || part.mediaType === "text/csv",
  );
  if (!text && fileParts.length === 0) return null;
  return (
    <div style={{ display: "flex", justifyContent: "flex-end", margin: "18px 0 6px", animation: "lbChatRise 180ms ease" }}>
      <div style={{ maxWidth: "min(560px, 86%)" }}>
        {documents.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, justifyContent: "flex-end", marginBottom: 6 }}>
            {documents.map((part, index) => (
              <span
                key={index}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  height: 24,
                  padding: "0 9px",
                  borderRadius: 7,
                  border: `1px solid ${LB.border}`,
                  background: LB.surface,
                  fontSize: 12,
                  color: LB.textMid,
                }}
              >
                <span style={{ fontSize: 11 }}>{part.mediaType === "text/csv" ? "🧾" : "📄"}</span>
                <span style={{ maxWidth: 180, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {typeof part.filename === "string" ? part.filename : `document ${index + 1}`}
                </span>
              </span>
            ))}
          </div>
        )}
        {images.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, justifyContent: "flex-end", marginBottom: text ? 6 : 0 }}>
            {images.map((part, index) => (
              <img
                key={index}
                src={part.url as string}
                alt={typeof part.filename === "string" ? part.filename : `attachment ${index + 1}`}
                title={typeof part.filename === "string" ? part.filename : undefined}
                style={{
                  maxWidth: 180,
                  maxHeight: 180,
                  borderRadius: 10,
                  border: `1px solid ${LB.border}`,
                  objectFit: "cover",
                }}
              />
            ))}
          </div>
        )}
        {text && (
          <div style={{
            padding: "10px 14px",
            borderRadius: "14px 14px 4px 14px",
            background: LB.surfaceAlt,
            border: `1px solid ${LB.border}`,
            fontSize: 14.5,
            lineHeight: 1.6,
            color: LB.text,
            whiteSpace: "pre-wrap",
            overflowWrap: "anywhere",
          }}>
            {text}
          </div>
        )}
      </div>
    </div>
  );
}

function AssistantMessage({ message, isStreaming }: { message: UIMessage; isStreaming: boolean }) {
  const parts = message.parts as AnyPart[];
  // Find the last text part so only it gets the live cursor.
  let lastTextIndex = -1;
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    if (parts[i].type === "text") {
      lastTextIndex = i;
      break;
    }
  }

  return (
    <div style={{ margin: "6px 0 4px", animation: "lbChatRise 180ms ease" }}>
      {parts.map((part, index) => {
        const type = typeof part.type === "string" ? part.type : "";
        if (type === "text") {
          const text = typeof part.text === "string" ? part.text : "";
          if (!text.trim()) return null;
          return (
            <StreamingText
              key={index}
              text={text}
              withCursor={isStreaming && index === lastTextIndex}
            />
          );
        }
        if (type === "reasoning") {
          const text = typeof part.text === "string" ? part.text : "";
          const streaming = isStreaming && part.state === "streaming";
          if (!text.trim() && !streaming) return null;
          return <ReasoningBlock key={index} text={text} streaming={streaming} />;
        }
        if (type.startsWith("tool-") || type === "dynamic-tool") {
          return <ToolActivity key={index} part={part} />;
        }
        return null;
      })}
    </div>
  );
}

/**
 * Failure banner with expandable detail. The backend forwards the provider's
 * actual error (status + response body) in the error text; the collapsed row
 * shows the first line, Details reveals the full payload for diagnosis.
 */
function ErrorBanner({ error, onRetry }: { error: Error; onRetry: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const fullText = error.message || "Agent chat failed";
  const summary = fullText.split(" — ")[0].split("\n")[0];
  const hasDetail = fullText.length > summary.length;

  return (
    <div style={{
      margin: "10px 0",
      padding: "10px 13px",
      borderRadius: 10,
      background: LB.redSoft,
      border: `1px solid ${LB.red}33`,
      color: LB.red,
      fontSize: 13,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{ fontWeight: 700, flexShrink: 0 }}>Something went wrong.</span>
        <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {summary}
        </span>
        {hasDetail && (
          <button
            type="button"
            onClick={() => setExpanded((value) => !value)}
            style={{
              marginLeft: "auto",
              flexShrink: 0,
              height: 26,
              padding: "0 10px",
              borderRadius: 8,
              border: `1px solid ${LB.red}55`,
              background: "transparent",
              color: LB.red,
              fontSize: 12,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            {expanded ? "Hide details" : "Details"}
          </button>
        )}
        <button
          type="button"
          onClick={onRetry}
          style={{
            marginLeft: hasDetail ? 0 : "auto",
            flexShrink: 0,
            height: 26,
            padding: "0 12px",
            borderRadius: 8,
            border: `1px solid ${LB.red}`,
            background: LB.surface,
            color: LB.red,
            fontSize: 12,
            fontWeight: 700,
            cursor: "pointer",
          }}
        >
          Retry
        </button>
      </div>
      {expanded && (
        <pre style={{
          margin: "9px 0 0",
          padding: "9px 11px",
          borderRadius: 8,
          background: LB.surface,
          border: `1px solid ${LB.red}33`,
          color: LB.textMid,
          fontFamily: FONTS.mono,
          fontSize: 11.5,
          lineHeight: 1.55,
          whiteSpace: "pre-wrap",
          overflowWrap: "anywhere",
          maxHeight: 260,
          overflowY: "auto",
          userSelect: "text",
        }}>
          {fullText}
        </pre>
      )}
    </div>
  );
}

export function ChatThread({
  messages,
  status,
  isStreaming,
  error,
  onRetry,
}: {
  messages: UIMessage[];
  status: string;
  isStreaming: boolean;
  error: Error | undefined;
  onRetry: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pinnedRef = useRef(true);
  const [showJump, setShowJump] = useState(false);

  const lastMessage = messages[messages.length - 1];
  const waitingForFirstSign = status === "submitted"
    || (isStreaming
      && (!lastMessage || lastMessage.role !== "assistant"
        || !(lastMessage.parts as AnyPart[]).some((part) => {
          const type = typeof part.type === "string" ? part.type : "";
          if (type === "reasoning" || type.startsWith("tool-")) return true;
          return type === "text" && typeof part.text === "string" && part.text.trim().length > 0;
        })));

  // Stick to bottom while the user hasn't scrolled away.
  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    if (pinnedRef.current) node.scrollTop = node.scrollHeight;
  });

  const onScroll = () => {
    const node = scrollRef.current;
    if (!node) return;
    const nearBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 80;
    pinnedRef.current = nearBottom;
    setShowJump(!nearBottom);
  };

  return (
    <div style={{ position: "relative", flex: 1, minHeight: 0 }}>
      <div
        ref={scrollRef}
        onScroll={onScroll}
        style={{ height: "100%", overflowY: "auto", padding: "18px 20px 28px" }}
      >
        <div style={{ maxWidth: 760, margin: "0 auto" }}>
          {messages.length === 0 && !isStreaming && (
            <div style={{ textAlign: "center", padding: "96px 20px 0", color: LB.textDim }}>
              <div style={{ fontSize: 30, marginBottom: 10 }}>☀︎</div>
              <div style={{ fontSize: 16.5, fontWeight: 700, color: LB.text, marginBottom: 6 }}>
                What should we work on?
              </div>
              <div style={{ fontSize: 13.5, lineHeight: 1.6, maxWidth: 440, margin: "0 auto" }}>
                Attach a design image and say{" "}
                <span style={{ fontFamily: "monospace" }}>make this into a mug</span>
                {" "}— I'll create the product, show Printify's mockups, and you can
                order it right from the chat. I also read PDFs and delegate tasks to a subagent.
              </div>
            </div>
          )}
          {messages.map((message, index) =>
            message.role === "user" ? (
              <UserMessage key={message.id} message={message} />
            ) : message.role === "assistant" ? (
              <AssistantMessage
                key={message.id}
                message={message}
                isStreaming={isStreaming && index === messages.length - 1}
              />
            ) : null,
          )}
          {waitingForFirstSign && <ThinkingIndicator />}
          {error && <ErrorBanner error={error} onRetry={onRetry} />}
        </div>
      </div>
      {showJump && (
        <button
          type="button"
          onClick={() => {
            const node = scrollRef.current;
            if (node) {
              pinnedRef.current = true;
              node.scrollTo({ top: node.scrollHeight, behavior: "smooth" });
              setShowJump(false);
            }
          }}
          style={{
            position: "absolute",
            bottom: 14,
            left: "50%",
            transform: "translateX(-50%)",
            height: 30,
            padding: "0 14px",
            borderRadius: 999,
            border: `1px solid ${LB.border}`,
            background: LB.surface,
            boxShadow: "0 4px 16px rgba(17,17,17,0.10)",
            color: LB.textMid,
            fontSize: 12,
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          ↓ Latest
        </button>
      )}
    </div>
  );
}
