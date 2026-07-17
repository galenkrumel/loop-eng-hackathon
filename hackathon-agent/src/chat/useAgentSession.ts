import { useCallback, useMemo, useRef, useState } from "react";
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import type { UIMessage } from "ai";
import type { PendingImage } from "./images";

/** Kebab-case of the ChatAgent DO binding — the Agents SDK route namespace. */
export const CHAT_AGENT_NAMESPACE = "chat-agent";

/** Synced from the DO via the Agents SDK state channel after each turn. */
export type AgentMeta = {
  title: string | null;
  lastInputTokens: number | null;
  contextTokens: number | null;
  compactionCount: number;
  updatedAt: string | null;
};

/**
 * One live chat session: a WebSocket to this chat's Durable Object instance
 * with the Agents SDK chat protocol on top — message sync, streaming
 * UIMessage chunks, resume-on-reconnect, server-side cancel.
 *
 * Every callback handed to the SDK hooks is identity-stable across renders
 * (volatile values ride refs): unstable options make the hooks re-arm
 * internal subscriptions every render.
 */
export function useAgentSession({
  chatId,
  onTurnFinished,
}: {
  chatId: string;
  onTurnFinished: () => void;
}) {
  const [meta, setMeta] = useState<AgentMeta | null>(null);
  const [connected, setConnected] = useState(false);
  const onTurnFinishedRef = useRef(onTurnFinished);
  onTurnFinishedRef.current = onTurnFinished;

  const handleStateUpdate = useCallback((state: AgentMeta) => setMeta(state), []);
  const handleOpen = useCallback(() => setConnected(true), []);
  const handleClose = useCallback(() => setConnected(false), []);
  const handleFinish = useCallback(() => onTurnFinishedRef.current(), []);

  const agent = useAgent({
    agent: CHAT_AGENT_NAMESPACE,
    name: chatId,
    onStateUpdate: handleStateUpdate,
    onOpen: handleOpen,
    onClose: handleClose,
  });

  const chat = useAgentChat({
    agent,
    // Coalesce message-store notifications so fast token streams render in
    // batches instead of one commit per chunk.
    experimental_throttle: 60,
    onFinish: handleFinish,
  });

  const sendChatMessage = useCallback((text: string, images: PendingImage[] = []) => {
    // Attachments ride the message as file parts carrying /files/ R2 URLs
    // (uploaded via /api/uploads before send) — never data URLs, which blow
    // the DO's SQLite row limit on large files.
    const parts: UIMessage["parts"] = images.map((image) => ({
      type: "file" as const,
      mediaType: image.mediaType,
      filename: image.filename,
      url: image.url,
    }));
    if (text) parts.push({ type: "text", text });
    if (parts.length === 0) return;
    void chat.sendMessage({ role: "user", parts });
  }, [chat]);

  return useMemo(() => ({
    agent,
    chat,
    meta,
    connected,
    sendChatMessage,
  }), [agent, chat, meta, connected, sendChatMessage]);
}
