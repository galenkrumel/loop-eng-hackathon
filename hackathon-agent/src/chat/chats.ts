/**
 * Client-side chat registry. The full app keeps this in D1 so the sidebar can
 * list conversations without waking DOs; the barebones version keeps it in
 * localStorage — each chat's transcript still lives in its own Durable
 * Object, this is only the sidebar index.
 */

export type ChatListEntry = {
  id: string;
  title: string | null;
  updated_at: string;
};

const STORAGE_KEY = "hackathon-agent.chats";

type Listener = () => void;
const listeners = new Set<Listener>();

function notify() {
  for (const listener of listeners) listener();
}

export function subscribeToChats(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function listChats(): ChatListEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) as ChatListEntry[] : [];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((entry) => entry && typeof entry.id === "string")
      .sort((left, right) => (right.updated_at ?? "").localeCompare(left.updated_at ?? ""));
  } catch {
    return [];
  }
}

function save(entries: ChatListEntry[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // Storage full/unavailable — the sidebar just won't persist.
  }
  notify();
}

export function touchChat(id: string, title?: string | null) {
  const entries = listChats();
  const existing = entries.find((entry) => entry.id === id);
  const next: ChatListEntry = {
    id,
    title: title !== undefined ? title : existing?.title ?? null,
    updated_at: new Date().toISOString(),
  };
  save([next, ...entries.filter((entry) => entry.id !== id)]);
}

export function renameChat(id: string, title: string) {
  save(listChats().map((entry) => (entry.id === id ? { ...entry, title } : entry)));
}

export function deleteChat(id: string) {
  save(listChats().filter((entry) => entry.id !== id));
}
