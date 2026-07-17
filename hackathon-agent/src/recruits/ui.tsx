import { useState, type CSSProperties } from "react";
import { LB, FONTS } from "../lb";
import type { Recruit, RecruitStatus } from "./api";

/** Shared atoms for the recruits page — same "two voices" system as chat:
 * prose in Inter, telemetry (labels, counts, timestamps) in mono. */

export const STATUS_META: Record<RecruitStatus, { label: string; fg: string; bg: string }> = {
  new: { label: "New", fg: LB.slate, bg: LB.slateSoft },
  enriched: { label: "Enriched", fg: LB.blueDeep, bg: LB.blueSoft },
  merch_created: { label: "Merch created", fg: LB.amber, bg: LB.amberSoft },
  ordered: { label: "Ordered", fg: LB.green, bg: LB.greenSoft },
  failed: { label: "Failed", fg: LB.red, bg: LB.redSoft },
};

/** Saturation fields in pipeline order (mirrors worker SATURATION_FIELDS). */
export const PIPELINE_STEPS = [
  { key: "linkedin_url", label: "LinkedIn" },
  { key: "enrichment", label: "Enrichment" },
  { key: "profile_image_url", label: "Photo" },
  { key: "design_image_url", label: "Design" },
  { key: "printify_product_id", label: "Product" },
  { key: "mockup_images", label: "Mockups" },
] as const;

export function stepDone(recruit: Recruit, key: (typeof PIPELINE_STEPS)[number]["key"]): boolean {
  return !(recruit.missing ?? []).includes(key);
}

export function StatusPill({ status }: { status: RecruitStatus }) {
  const meta = STATUS_META[status] ?? STATUS_META.new;
  return (
    <span style={{
      display: "inline-flex",
      alignItems: "center",
      padding: "2px 9px",
      borderRadius: 999,
      background: meta.bg,
      color: meta.fg,
      fontFamily: FONTS.mono,
      fontSize: 10.5,
      fontWeight: 600,
      whiteSpace: "nowrap",
    }}>
      {meta.label}
    </span>
  );
}

function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join("") || "?";
}

export function Avatar({ recruit, size }: { recruit: Recruit; size: number }) {
  const [broken, setBroken] = useState(false);
  const url = recruit.profile_image_url;
  const box: CSSProperties = {
    width: size,
    height: size,
    borderRadius: Math.round(size * 0.32),
    flexShrink: 0,
    border: `1px solid ${LB.border}`,
  };
  if (!url || broken) {
    return (
      <span style={{
        ...box,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        background: LB.slateSoft,
        color: LB.textMid,
        fontSize: Math.round(size * 0.36),
        fontWeight: 700,
      }}>
        {initialsOf(recruit.name)}
      </span>
    );
  }
  return (
    <img
      src={url}
      alt={recruit.name}
      onError={() => setBroken(true)}
      style={{ ...box, objectFit: "cover", background: LB.surfaceAlt }}
    />
  );
}

/** Mono uppercase micro-label (the OrderForm/sidebar group-header voice). */
export const monoLabelStyle: CSSProperties = {
  fontFamily: FONTS.mono,
  fontSize: 10,
  fontWeight: 600,
  color: LB.textDim,
  textTransform: "uppercase",
  letterSpacing: "0.08em",
};

export const fieldStyle: CSSProperties = {
  height: 32,
  padding: "0 10px",
  borderRadius: 8,
  border: `1px solid ${LB.border}`,
  background: LB.surface,
  fontSize: 12.5,
  fontFamily: "inherit",
  outline: "none",
  minWidth: 0,
  width: "100%",
  boxSizing: "border-box",
};
