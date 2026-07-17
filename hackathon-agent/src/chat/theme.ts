/**
 * Chat workspace theme: the "two voices" system.
 *
 * Human voice — prose, titles — renders in the app sans (Inter). Machine
 * voice — tool operations, token telemetry — renders in the mono stack, so
 * the eye can separate what the assistant SAID from what it DID.
 */

/** One-time keyframes for the chat page (shimmer, breath, entrance, spin). */
export const CHAT_KEYFRAMES = `
@keyframes lbChatBreath {
  0%, 100% { transform: scale(0.82); opacity: 0.55; }
  50% { transform: scale(1.08); opacity: 1; }
}
@keyframes lbChatShimmer {
  0% { background-position: 180% 50%; }
  100% { background-position: -80% 50%; }
}
@keyframes lbChatRise {
  from { opacity: 0; transform: translateY(6px); }
  to { opacity: 1; transform: translateY(0); }
}
@keyframes lbChatSpin {
  to { transform: rotate(360deg); }
}
@keyframes lbChatBlink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0; }
}
`;

export const shimmerTextStyle = (base: string): React.CSSProperties => ({
  backgroundImage: `linear-gradient(90deg, ${base} 0%, ${base} 38%, #B9B8B0 50%, ${base} 62%, ${base} 100%)`,
  backgroundSize: "200% 100%",
  WebkitBackgroundClip: "text",
  backgroundClip: "text",
  WebkitTextFillColor: "transparent",
  color: "transparent",
  animation: "lbChatShimmer 2.2s linear infinite",
});

export function formatTokens(value: number | null | undefined): string {
  const count = value ?? 0;
  if (count < 1000) return `${count}`;
  if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1_000_000).toFixed(2)}M`;
}

export function formatRelativeTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";
  const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 7 * 86_400) return `${Math.floor(seconds / 86_400)}d ago`;
  return new Date(then).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Group key for the sidebar (Today / Yesterday / Previous 7 days / Older). */
export function chatGroupOf(iso: string | null | undefined): string {
  if (!iso) return "Older";
  const then = new Date(iso);
  if (!Number.isFinite(then.getTime())) return "Older";
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const t = then.getTime();
  if (t >= startOfToday) return "Today";
  if (t >= startOfToday - 86_400_000) return "Yesterday";
  if (t >= startOfToday - 7 * 86_400_000) return "Previous 7 days";
  return "Older";
}

export const CHAT_GROUP_ORDER = ["Today", "Yesterday", "Previous 7 days", "Older"];
