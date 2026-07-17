import { useCallback, useEffect, useMemo, useState } from "react";
import { LB, FONTS } from "./lb";
import { CHAT_KEYFRAMES, formatTokens } from "./chat/theme";
import { ChatSidebar } from "./chat/ChatSidebar";
import { ChatThread } from "./chat/ChatThread";
import { RecruitsPage } from "./recruits/RecruitsPage";
import { Composer } from "./chat/Composer";
import { useAgentSession } from "./chat/useAgentSession";
import type { PendingImage } from "./chat/images";
import {
  deleteChat,
  listChats,
  renameChat,
  subscribeToChats,
  touchChat,
  type ChatListEntry,
} from "./chat/chats";

function ContextMeter({ used, total }: { used: number | null; total: number | null }) {
  if (!used || !total || total <= 0) return null;
  const ratio = Math.min(1, used / total);
  const radius = 7;
  const circumference = 2 * Math.PI * radius;
  return (
    <span
      title={`Context: ${formatTokens(used)} of ${formatTokens(total)} tokens`}
      style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
    >
      <svg width="18" height="18" viewBox="0 0 18 18" style={{ transform: "rotate(-90deg)" }}>
        <circle cx="9" cy="9" r={radius} fill="none" stroke={LB.border} strokeWidth="3" />
        <circle
          cx="9"
          cy="9"
          r={radius}
          fill="none"
          stroke={ratio > 0.75 ? LB.amber : LB.blue}
          strokeWidth="3"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - ratio)}
          strokeLinecap="round"
        />
      </svg>
      <span style={{ fontFamily: FONTS.mono, fontSize: 10.5, color: LB.textDim }}>
        {formatTokens(used)} / {formatTokens(total)}
      </span>
    </span>
  );
}

/** Views live in the URL hash (#/chat/<id>, #/recruits) — shareable and
 * reload-safe without pulling in a router. */
type Route =
  | { view: "chat"; chatId: string | null }
  | { view: "recruits"; selected: string | null };

function routeFromHash(): Route {
  if (window.location.hash.startsWith("#/recruits")) {
    const match = window.location.hash.match(/^#\/recruits\/(.+)$/);
    return { view: "recruits", selected: match ? decodeURIComponent(match[1]) : null };
  }
  const match = window.location.hash.match(/^#\/chat\/(.+)$/);
  return { view: "chat", chatId: match ? match[1] : null };
}

function useHashRoute(): [Route, (id: string) => void, () => void] {
  const [route, setRoute] = useState<Route>(routeFromHash);
  useEffect(() => {
    const onHashChange = () => setRoute(routeFromHash());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);
  const navigateToChat = useCallback((id: string) => {
    window.location.hash = `#/chat/${id}`;
  }, []);
  const navigateToRecruits = useCallback(() => {
    window.location.hash = "#/recruits";
  }, []);
  return [route, navigateToChat, navigateToRecruits];
}

function ChatSession({
  chatId,
  chats,
  onOpenSidebar,
  showSidebarButton,
}: {
  chatId: string;
  chats: ChatListEntry[];
  onOpenSidebar: () => void;
  showSidebarButton: boolean;
}) {
  const session = useAgentSession({
    chatId,
    onTurnFinished: () => touchChat(chatId),
  });
  const { chat, meta, connected } = session;

  const listEntry = chats.find((entry) => entry.id === chatId) ?? null;
  const title = meta?.title ?? listEntry?.title ?? "New chat";
  const isStreaming = chat.status === "submitted" || chat.status === "streaming";

  // The DO names the chat after the first turn (title arrives over the state
  // channel) — mirror it into the sidebar registry.
  const metaTitle = meta?.title ?? null;
  useEffect(() => {
    if (metaTitle) touchChat(chatId, metaTitle);
  }, [metaTitle, chatId]);

  const onSend = (text: string, images: PendingImage[]) => {
    touchChat(chatId);
    session.sendChatMessage(text, images);
  };

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0, minHeight: 0, background: LB.bg }}>
      <header style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "10px 20px",
        borderBottom: `1px solid ${LB.border}`,
        background: LB.bg,
      }}>
        {showSidebarButton && (
          <button
            type="button"
            onClick={onOpenSidebar}
            aria-label="Open chat list"
            style={{
              width: 30,
              height: 30,
              borderRadius: 8,
              border: `1px solid ${LB.border}`,
              background: LB.surface,
              color: LB.textMid,
              cursor: "pointer",
              fontSize: 14,
            }}
          >
            ☰
          </button>
        )}
        <span style={{
          fontSize: 14,
          fontWeight: 700,
          color: LB.text,
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
          minWidth: 0,
        }}>
          {title}
        </span>
        <span style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 5,
          fontFamily: FONTS.mono,
          fontSize: 10.5,
          color: connected ? LB.green : LB.amber,
          flexShrink: 0,
        }}>
          <span style={{
            width: 7,
            height: 7,
            borderRadius: 999,
            background: connected ? LB.green : LB.amber,
            animation: connected ? undefined : "lbChatBreath 1.4s ease-in-out infinite",
          }} />
          {connected ? "live" : "reconnecting"}
        </span>
        <span style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 12 }}>
          {(meta?.compactionCount ?? 0) > 0 && (
            <span
              title={`Context compacted ${meta!.compactionCount} time${meta!.compactionCount === 1 ? "" : "s"}`}
              style={{ fontFamily: FONTS.mono, fontSize: 10.5, color: LB.textDim }}
            >
              ⊜ ×{meta!.compactionCount}
            </span>
          )}
          <ContextMeter used={meta?.lastInputTokens ?? null} total={meta?.contextTokens ?? null} />
        </span>
      </header>

      <ChatThread
        messages={chat.messages}
        status={chat.status}
        isStreaming={isStreaming}
        error={chat.error}
        onRetry={() => void chat.regenerate()}
      />

      <Composer
        disabled={!connected && chat.messages.length === 0}
        isStreaming={isStreaming}
        onSend={onSend}
        onStop={() => void chat.stop()}
        connectionLabel={connected ? null : "Offline — reconnecting…"}
      />
    </div>
  );
}

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const list = window.matchMedia(query);
    const onChange = () => setMatches(list.matches);
    list.addEventListener("change", onChange);
    return () => list.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}

export default function App() {
  const [route, navigate, navigateToRecruits] = useHashRoute();
  const chatId = route.view === "chat" ? route.chatId : null;
  const wideEnoughForSidebar = useMediaQuery("(min-width: 920px)");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [chats, setChats] = useState<ChatListEntry[]>(listChats);

  useEffect(() => subscribeToChats(() => setChats(listChats())), []);

  // No chat in the URL: jump into a fresh conversation.
  useEffect(() => {
    if (route.view === "chat" && !route.chatId) navigate(crypto.randomUUID());
  }, [route, navigate]);

  const openChat = useCallback((id: string) => {
    setDrawerOpen(false);
    navigate(id);
  }, [navigate]);

  const onNewChat = useCallback(() => {
    setDrawerOpen(false);
    navigate(crypto.randomUUID());
  }, [navigate]);

  const onDeleteChat = useCallback((id: string) => {
    deleteChat(id);
    if (id === chatId) onNewChat();
  }, [chatId, onNewChat]);

  const activeIsUnsaved = useMemo(
    () => !!chatId && !chats.some((chat) => chat.id === chatId),
    [chatId, chats],
  );

  return (
    <div style={{
      height: "100dvh",
      display: "flex",
      flexDirection: "column",
      background: LB.bg,
      fontFamily: FONTS.sans,
      color: LB.text,
    }}>
      <style>{CHAT_KEYFRAMES}</style>
      {route.view === "recruits" ? (
        <RecruitsPage
          initialSelected={route.selected}
          onBack={() => navigate(chats[0]?.id ?? crypto.randomUUID())}
        />
      ) : !chatId ? (
        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: LB.textDim, fontSize: 13.5 }}>
          Loading…
        </div>
      ) : (
        <div style={{ flex: 1, display: "flex", minHeight: 0, position: "relative" }}>
          {wideEnoughForSidebar ? (
            <ChatSidebar
              chats={chats}
              activeChatId={chatId}
              activeIsUnsaved={activeIsUnsaved}
              onNewChat={onNewChat}
              onOpenRecruits={navigateToRecruits}
              onOpenChat={openChat}
              onRenameChat={renameChat}
              onDeleteChat={onDeleteChat}
            />
          ) : drawerOpen ? (
            <div
              onClick={() => setDrawerOpen(false)}
              style={{ position: "absolute", inset: 0, zIndex: 40, background: "rgba(17,17,17,0.28)" }}
            >
              <div onClick={(event) => event.stopPropagation()} style={{ height: "100%", display: "flex" }}>
                <ChatSidebar
                  chats={chats}
                  activeChatId={chatId}
                  activeIsUnsaved={activeIsUnsaved}
                  onNewChat={onNewChat}
                  onOpenRecruits={() => {
                    setDrawerOpen(false);
                    navigateToRecruits();
                  }}
                  onOpenChat={openChat}
                  onRenameChat={renameChat}
                  onDeleteChat={onDeleteChat}
                />
              </div>
            </div>
          ) : null}

          <ChatSession
            key={chatId}
            chatId={chatId}
            chats={chats}
            onOpenSidebar={() => setDrawerOpen(true)}
            showSidebarButton={!wideEnoughForSidebar}
          />
        </div>
      )}
    </div>
  );
}
