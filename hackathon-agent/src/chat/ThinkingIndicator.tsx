import { useEffect, useState } from "react";
import { LB } from "../lb";
import { shimmerTextStyle } from "./theme";

const PHASES = ["Thinking", "Working on it", "Still thinking"];

/**
 * Claude-style waiting state: a breathing ink orb plus a shimmering status
 * word that rotates the longer the model takes — the user always sees the
 * agent is alive, never a frozen page.
 */
export function ThinkingIndicator() {
  const [phase, setPhase] = useState(0);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      const seconds = Math.round((Date.now() - startedAt) / 1000);
      setElapsed(seconds);
      setPhase(Math.min(PHASES.length - 1, Math.floor(seconds / 7)));
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  return (
    <div style={{
      display: "flex",
      alignItems: "center",
      gap: 10,
      padding: "4px 0 12px",
      animation: "lbChatRise 200ms ease",
    }}>
      <span style={{
        width: 13,
        height: 13,
        borderRadius: 999,
        background: LB.text,
        animation: "lbChatBreath 1.6s ease-in-out infinite",
        flexShrink: 0,
      }} />
      <span style={{ fontSize: 13.5, fontWeight: 600, ...shimmerTextStyle(LB.textDim) }}>
        {PHASES[phase]}…{elapsed >= 4 ? ` ${elapsed}s` : ""}
      </span>
    </div>
  );
}
