import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { LB, FONTS } from "../lb";
import { CHAT_GROUP_ORDER, chatGroupOf, formatRelativeTime } from "./theme";
import type { ChatListEntry } from "./chats";

/**
 * Recent-chats rail, claude.ai-style: single-line title rows that keep their
 * full width until hover, when a ⋯ menu fades in over the trailing edge.
 */

const ROW_HEIGHT = 34;
const MENU_HEIGHT_ESTIMATE = 96;

function MenuItem({
  onClick,
  danger = false,
  emphasized = false,
  children,
}: {
  onClick: () => void;
  danger?: boolean;
  emphasized?: boolean;
  children: ReactNode;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: "block",
        width: "100%",
        textAlign: "left",
        padding: "7px 10px",
        border: "none",
        borderRadius: 7,
        background: emphasized ? LB.redSoft : hovered ? LB.surfaceAlt : "transparent",
        color: danger ? LB.red : LB.text,
        fontSize: 12.5,
        fontWeight: emphasized ? 600 : 500,
        cursor: "pointer",
        font: "inherit",
      }}
    >
      {children}
    </button>
  );
}

function ChatRow({
  chat,
  active,
  onOpen,
  onRename,
  onDelete,
}: {
  chat: ChatListEntry;
  active: boolean;
  onOpen: () => void;
  onRename: (title: string) => void;
  onDelete: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(chat.title ?? "");
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuUp, setMenuUp] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const rowRef = useRef<HTMLDivElement | null>(null);

  const closeMenu = () => {
    setMenuOpen(false);
    setConfirming(false);
  };

  useEffect(() => {
    if (!menuOpen) return;
    const onMouseDown = (event: MouseEvent) => {
      if (rowRef.current && event.target instanceof Node && !rowRef.current.contains(event.target)) {
        closeMenu();
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeMenu();
    };
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [menuOpen]);

  const openMenu = () => {
    // Flip upward near the bottom of the scroll rail so the menu doesn't
    // extend the scroll area.
    const row = rowRef.current;
    const rail = row?.closest("[data-chat-scroll]");
    if (row && rail) {
      const rowRect = row.getBoundingClientRect();
      const railRect = rail.getBoundingClientRect();
      setMenuUp(rowRect.bottom + MENU_HEIGHT_ESTIMATE > railRect.bottom);
    } else {
      setMenuUp(false);
    }
    setConfirming(false);
    setMenuOpen(true);
  };

  const commitRename = () => {
    setEditing(false);
    const next = draft.trim();
    if (next && next !== chat.title) onRename(next);
    else setDraft(chat.title ?? "");
  };

  const rowBg = active ? LB.slateSoft : hovered || menuOpen ? LB.surfaceAlt : "transparent";
  const title = chat.title ?? "Untitled chat";
  const tooltip = [title, formatRelativeTime(chat.updated_at)].filter(Boolean).join(" · ");

  return (
    <div
      ref={rowRef}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        position: "relative",
        borderRadius: 8,
        background: rowBg,
        transition: "background 100ms ease",
      }}
    >
      {editing ? (
        <input
          autoFocus
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commitRename}
          onKeyDown={(event) => {
            if (event.key === "Enter") commitRename();
            if (event.key === "Escape") {
              setDraft(chat.title ?? "");
              setEditing(false);
            }
          }}
          style={{
            width: "100%",
            boxSizing: "border-box",
            margin: 0,
            padding: "0 10px",
            height: ROW_HEIGHT,
            border: `1px solid ${LB.blue}`,
            borderRadius: 8,
            fontSize: 13,
            fontFamily: "inherit",
            outline: "none",
            background: LB.surface,
          }}
        />
      ) : (
        <button
          type="button"
          onClick={() => {
            closeMenu();
            onOpen();
          }}
          title={tooltip}
          style={{
            display: "flex",
            alignItems: "center",
            width: "100%",
            height: ROW_HEIGHT,
            textAlign: "left",
            border: "none",
            background: "transparent",
            padding: "0 10px",
            cursor: "pointer",
            font: "inherit",
            minWidth: 0,
          }}
        >
          <span style={{
            flex: 1,
            fontSize: 13,
            fontWeight: active ? 600 : 500,
            color: LB.text,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            minWidth: 0,
          }}>
            {title}
          </span>
        </button>
      )}

      {!editing && (hovered || menuOpen) && (
        <div style={{
          position: "absolute",
          top: 0,
          right: 0,
          bottom: 0,
          display: "flex",
          alignItems: "center",
          padding: "0 5px 0 22px",
          background: `linear-gradient(90deg, transparent, ${rowBg} 18px)`,
          borderRadius: "0 8px 8px 0",
          pointerEvents: "none",
        }}>
          <button
            type="button"
            aria-label="Chat options"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            title="Options"
            onClick={(event) => {
              event.stopPropagation();
              if (menuOpen) closeMenu();
              else openMenu();
            }}
            style={{
              pointerEvents: "auto",
              width: 24,
              height: 24,
              borderRadius: 6,
              border: "none",
              background: menuOpen ? "rgba(17,17,17,0.08)" : "transparent",
              color: LB.textMid,
              cursor: "pointer",
              fontSize: 16,
              fontWeight: 700,
              lineHeight: 1,
              padding: 0,
            }}
          >
            ⋯
          </button>
        </div>
      )}

      {menuOpen && (
        <div
          role="menu"
          style={{
            position: "absolute",
            right: 6,
            ...(menuUp ? { bottom: "calc(100% + 4px)" } : { top: "calc(100% + 4px)" }),
            zIndex: 60,
            minWidth: 150,
            padding: 4,
            background: LB.surface,
            border: `1px solid ${LB.border}`,
            borderRadius: 10,
            boxShadow: "0 8px 24px rgba(17,17,17,0.12)",
          }}
        >
          <MenuItem
            onClick={() => {
              closeMenu();
              setDraft(chat.title ?? "");
              setEditing(true);
            }}
          >
            Rename
          </MenuItem>
          <MenuItem
            danger
            emphasized={confirming}
            onClick={() => {
              if (confirming) {
                closeMenu();
                onDelete();
              } else {
                setConfirming(true);
              }
            }}
          >
            {confirming ? "Confirm delete" : "Delete"}
          </MenuItem>
        </div>
      )}
    </div>
  );
}

const groupHeaderStyle: CSSProperties = {
  padding: "0 10px 5px",
  fontFamily: FONTS.mono,
  fontSize: 10,
  fontWeight: 600,
  color: LB.textDim,
  textTransform: "uppercase",
  letterSpacing: "0.08em",
};

function NavRow({ onClick, glyph, children }: { onClick: () => void; glyph: string; children: ReactNode }) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        width: "100%",
        height: 32,
        padding: "0 10px",
        border: "none",
        borderRadius: 8,
        background: hovered ? LB.surfaceAlt : "transparent",
        color: LB.textMid,
        fontSize: 13,
        fontWeight: 600,
        cursor: "pointer",
        font: "inherit",
        textAlign: "left",
      }}
    >
      <span aria-hidden style={{ fontSize: 13, lineHeight: 1 }}>{glyph}</span>
      {children}
    </button>
  );
}

export function ChatSidebar({
  chats,
  activeChatId,
  activeIsUnsaved,
  onNewChat,
  onOpenRecruits,
  onOpenChat,
  onRenameChat,
  onDeleteChat,
}: {
  chats: ChatListEntry[];
  activeChatId: string | null;
  activeIsUnsaved: boolean;
  onNewChat: () => void;
  onOpenRecruits: () => void;
  onOpenChat: (chatId: string) => void;
  onRenameChat: (chatId: string, title: string) => void;
  onDeleteChat: (chatId: string) => void;
}) {
  const groups = useMemo(() => {
    const byGroup = new Map<string, ChatListEntry[]>();
    for (const chat of chats) {
      const group = chatGroupOf(chat.updated_at);
      const list = byGroup.get(group) ?? [];
      list.push(chat);
      byGroup.set(group, list);
    }
    return CHAT_GROUP_ORDER.filter((group) => byGroup.has(group)).map((group) => ({
      group,
      chats: byGroup.get(group)!,
    }));
  }, [chats]);

  return (
    <aside style={{
      width: 288,
      flexShrink: 0,
      display: "flex",
      flexDirection: "column",
      borderRight: `1px solid ${LB.border}`,
      background: LB.bg,
      minHeight: 0,
    }}>
      <div style={{ padding: "12px 10px 6px" }}>
        <button
          type="button"
          onClick={onNewChat}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 7,
            width: "100%",
            height: 36,
            border: "none",
            borderRadius: 10,
            background: LB.blue,
            color: "#FFF",
            fontSize: 13.5,
            fontWeight: 700,
            cursor: "pointer",
            font: "inherit",
          }}
        >
          <span style={{ fontSize: 15, fontWeight: 700, lineHeight: 1 }}>+</span>
          New chat
        </button>
        <div style={{ marginTop: 6 }}>
          <NavRow onClick={onOpenRecruits} glyph="⛁">Recruits</NavRow>
        </div>
      </div>

      <div data-chat-scroll style={{ flex: 1, overflowY: "auto", overflowX: "hidden", padding: "0 10px 16px" }}>
        {activeIsUnsaved && activeChatId && (
          <div style={{
            marginTop: 8,
            padding: "7px 10px",
            borderRadius: 8,
            background: LB.slateSoft,
          }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: LB.text }}>New chat</div>
            <div style={{ fontSize: 11.5, color: LB.textDim, marginTop: 1 }}>
              Saves after your first message
            </div>
          </div>
        )}
        {groups.map(({ group, chats: groupChats }) => (
          <div key={group} style={{ marginTop: 14 }}>
            <div style={groupHeaderStyle}>{group}</div>
            {/* minmax(0,1fr): an auto track would grow to the widest nowrap
                title and push the rail into horizontal scroll. */}
            <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 1 }}>
              {groupChats.map((chat) => (
                <ChatRow
                  key={chat.id}
                  chat={chat}
                  active={chat.id === activeChatId}
                  onOpen={() => onOpenChat(chat.id)}
                  onRename={(title) => onRenameChat(chat.id, title)}
                  onDelete={() => onDeleteChat(chat.id)}
                />
              ))}
            </div>
          </div>
        ))}
        {chats.length === 0 && !activeIsUnsaved && (
          <div style={{ padding: "28px 10px", textAlign: "center", color: LB.textDim, fontSize: 12.5, lineHeight: 1.6 }}>
            No conversations yet.
            <br />
            Start one above.
          </div>
        )}
      </div>
    </aside>
  );
}
