import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { LB, FONTS } from "../lb";
import {
  RECRUIT_STATUSES,
  fetchRecruits,
  structuredEnrichment,
  type Recruit,
  type RecruitStatus,
  type RecruitsSummary,
} from "./api";
import { RecruitDetail } from "./RecruitDetail";
import { Avatar, STATUS_META, fieldStyle } from "./ui";

/**
 * Recruits dashboard — Sendoff-style master/detail viewer. A slim roster
 * column on the left (search, filters, avatar+name rows) and the rest of the
 * screen is one recruit's full profile, laid out like the merch studio's
 * design viewer. Data loads once from GET /api/recruits and all
 * search/filter/sort work happens client-side (the table is hackathon-scale).
 */

type SaturationFilter = "all" | "saturated" | "unsaturated";
type SortOrder = "updated" | "name";

/** Lower-cased searchable text for one recruit: row fields + enrichment. */
function haystackOf(recruit: Recruit): string {
  const parts: unknown[] = [
    recruit.name, recruit.company, recruit.linkedin_url, recruit.notes, recruit.status,
  ];
  const enrichment = structuredEnrichment(recruit);
  if (enrichment) {
    parts.push(
      enrichment.full_name, enrichment.headline, enrichment.current_title,
      enrichment.current_company, enrichment.industry, enrichment.location,
      ...(enrichment.emails ?? []), ...(enrichment.phones ?? []),
      ...(enrichment.skills ?? []),
      ...Object.values(enrichment.links ?? {}),
    );
    for (const role of enrichment.experience ?? []) parts.push(role.title, role.company);
    for (const school of enrichment.education ?? []) {
      parts.push(school.school, ...(school.degrees ?? []), ...(school.majors ?? []));
    }
  } else if (typeof recruit.enrichment === "string") {
    parts.push(recruit.enrichment);
  }
  return parts.filter((part) => typeof part === "string" && part).join(" ").toLowerCase();
}

function FilterChip({
  active,
  onClick,
  children,
  count,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  count?: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        height: 26,
        padding: "0 10px",
        borderRadius: 999,
        border: `1px solid ${active ? LB.blue : LB.border}`,
        background: active ? LB.blueSoft : LB.surface,
        color: active ? LB.blueDeep : LB.textMid,
        fontSize: 11.5,
        fontWeight: 600,
        cursor: "pointer",
        whiteSpace: "nowrap",
      }}
    >
      {children}
      {count != null && (
        <span style={{ fontFamily: FONTS.mono, fontSize: 10, color: active ? LB.blueDeep : LB.textDim }}>
          {count}
        </span>
      )}
    </button>
  );
}

/** One roster row: avatar + name, with a status tint dot. The profile itself
 * lives in the viewer on the right. */
function RecruitRowView({
  recruit,
  active,
  onOpen,
}: {
  recruit: Recruit;
  active: boolean;
  onOpen: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen();
        }
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "10px 14px",
        borderBottom: `1px solid ${LB.border}`,
        background: active ? LB.slateSoft : hovered ? LB.surfaceAlt : "transparent",
        cursor: "pointer",
        transition: "background 100ms ease",
      }}
    >
      <Avatar recruit={recruit} size={38} />
      <span style={{
        flex: 1,
        minWidth: 0,
        fontSize: 13.5,
        fontWeight: 600,
        color: LB.text,
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
      }}>
        {recruit.name}
      </span>
      <span
        title={STATUS_META[recruit.status]?.label ?? recruit.status}
        style={{
          width: 7,
          height: 7,
          borderRadius: 999,
          flexShrink: 0,
          background: STATUS_META[recruit.status]?.fg ?? LB.slate,
          opacity: active ? 1 : 0.55,
        }}
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

const headerButtonStyle: CSSProperties = {
  height: 30,
  padding: "0 12px",
  borderRadius: 8,
  border: `1px solid ${LB.border}`,
  background: LB.surface,
  color: LB.textMid,
  cursor: "pointer",
  fontSize: 12.5,
  fontWeight: 600,
};

export function RecruitsPage({
  initialSelected,
  onBack,
}: {
  initialSelected?: string | null;
  onBack: () => void;
}) {
  const [recruits, setRecruits] = useState<Recruit[] | null>(null);
  const [summary, setSummary] = useState<RecruitsSummary | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<RecruitStatus | "all">("all");
  const [saturationFilter, setSaturationFilter] = useState<SaturationFilter>("all");
  const [sortOrder, setSortOrder] = useState<SortOrder>("updated");
  const [selectedName, setSelectedNameState] = useState<string | null>(initialSelected ?? null);

  // Mirror the selection into the hash (#/recruits/<name>) so recruits are
  // deep-linkable; replaceState avoids a hashchange → route-remount loop.
  const setSelectedName = useCallback((name: string | null) => {
    setSelectedNameState(name);
    window.history.replaceState(null, "", name ? `#/recruits/${encodeURIComponent(name)}` : "#/recruits");
  }, []);

  const detailInline = useMediaQuery("(min-width: 880px)");

  const load = useCallback(async (asRefresh = false) => {
    if (asRefresh) setRefreshing(true);
    setLoadError(null);
    try {
      const payload = await fetchRecruits();
      setRecruits(payload.recruits);
      setSummary(payload.summary);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const haystacks = useMemo(() => {
    const map = new Map<string, string>();
    for (const recruit of recruits ?? []) map.set(recruit.name, haystackOf(recruit));
    return map;
  }, [recruits]);

  const statusCounts = useMemo(() => {
    const counts = Object.fromEntries(RECRUIT_STATUSES.map((status) => [status, 0])) as Record<RecruitStatus, number>;
    for (const recruit of recruits ?? []) counts[recruit.status] = (counts[recruit.status] ?? 0) + 1;
    return counts;
  }, [recruits]);

  const filtered = useMemo(() => {
    if (!recruits) return [];
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const rows = recruits.filter((recruit) => {
      if (statusFilter !== "all" && recruit.status !== statusFilter) return false;
      if (saturationFilter === "saturated" && !recruit.saturated) return false;
      if (saturationFilter === "unsaturated" && recruit.saturated) return false;
      if (terms.length > 0) {
        const hay = haystacks.get(recruit.name) ?? "";
        if (!terms.every((term) => hay.includes(term))) return false;
      }
      return true;
    });
    if (sortOrder === "name") rows.sort((a, b) => a.name.localeCompare(b.name));
    // "updated" keeps the server order (updated_at desc).
    return rows;
  }, [recruits, query, statusFilter, saturationFilter, sortOrder, haystacks]);

  const selected = useMemo(
    () => (selectedName ? recruits?.find((recruit) => recruit.name === selectedName) ?? null : null),
    [recruits, selectedName],
  );

  // Viewer-first: on wide screens something should always be showing, so fall
  // back to the first visible row when nothing (or a vanished row) is selected.
  // On narrow screens selection opens an overlay, so never auto-open there.
  useEffect(() => {
    if (!detailInline || !recruits || recruits.length === 0) return;
    if (selected) return;
    const first = filtered[0] ?? recruits[0];
    if (first) setSelectedName(first.name);
  }, [detailInline, recruits, filtered, selected, setSelectedName]);

  const onPatched = useCallback((name: string, patch: Partial<Recruit>) => {
    setRecruits((rows) => rows?.map((recruit) =>
      recruit.name === name
        ? { ...recruit, ...patch, updated_at: new Date().toISOString() }
        : recruit,
    ) ?? rows);
  }, []);

  const onDeleted = useCallback((name: string) => {
    setRecruits((rows) => rows?.filter((recruit) => recruit.name !== name) ?? rows);
    setSummary((prior) => prior ? { ...prior, db_total: Math.max(0, prior.db_total - 1) } : prior);
    setSelectedName(null);
  }, []);

  const roster = (
    <div style={{
      width: detailInline ? 300 : "100%",
      flexShrink: 0,
      minHeight: 0,
      display: "flex",
      flexDirection: "column",
      gap: 10,
    }}>
      <input
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search name, company, title, skills, emails…"
        style={{ ...fieldStyle, height: 36, borderRadius: 10 }}
      />
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        <FilterChip active={statusFilter === "all"} onClick={() => setStatusFilter("all")} count={recruits?.length}>
          All
        </FilterChip>
        {RECRUIT_STATUSES.map((status) => (
          <FilterChip
            key={status}
            active={statusFilter === status}
            onClick={() => setStatusFilter(statusFilter === status ? "all" : status)}
            count={statusCounts[status]}
          >
            {STATUS_META[status].label}
          </FilterChip>
        ))}
        <FilterChip
          active={saturationFilter === "saturated"}
          onClick={() => setSaturationFilter(saturationFilter === "saturated" ? "all" : "saturated")}
        >
          Saturated
        </FilterChip>
        <FilterChip
          active={saturationFilter === "unsaturated"}
          onClick={() => setSaturationFilter(saturationFilter === "unsaturated" ? "all" : "unsaturated")}
        >
          Unsaturated
        </FilterChip>
      </div>

      <div style={{
        flex: 1,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        background: LB.surface,
        border: `1px solid ${LB.border}`,
        borderRadius: 12,
        overflow: "hidden",
      }}>
        {recruits == null && !loadError && (
          <div style={{ padding: 48, textAlign: "center", color: LB.textDim, fontSize: 13 }}>
            Loading recruits…
          </div>
        )}
        {loadError && (
          <div style={{ padding: 40, textAlign: "center" }}>
            <div style={{ color: LB.red, fontSize: 13 }}>{loadError}</div>
            <button
              type="button"
              onClick={() => void load()}
              style={{ ...headerButtonStyle, marginTop: 12 }}
            >
              Retry
            </button>
          </div>
        )}
        {recruits != null && recruits.length === 0 && !loadError && (
          <div style={{ padding: 40, textAlign: "center", color: LB.textDim, fontSize: 13, lineHeight: 1.7 }}>
            No recruits yet.
            <br />
            Ask the agent to seed some — e.g. “add Jane Doe and Jon Smith to the recruits list”.
          </div>
        )}
        {recruits != null && recruits.length > 0 && (
          <>
            <div style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 8,
              padding: "7px 14px",
              borderBottom: `1px solid ${LB.border}`,
              background: LB.surfaceAlt,
            }}>
              <span style={{ fontFamily: FONTS.mono, fontSize: 10, fontWeight: 600, color: LB.textDim, textTransform: "uppercase", letterSpacing: "0.08em" }}>
                {filtered.length} of {recruits.length} recruits
              </span>
              <select
                value={sortOrder}
                onChange={(event) => setSortOrder(event.target.value as SortOrder)}
                style={{
                  border: "none",
                  background: "transparent",
                  fontFamily: FONTS.mono,
                  fontSize: 10,
                  color: LB.textDim,
                  cursor: "pointer",
                  outline: "none",
                  textAlign: "right",
                }}
              >
                <option value="updated">Recently updated</option>
                <option value="name">Name A–Z</option>
              </select>
            </div>
            <div style={{ flex: 1, overflowY: "auto" }}>
              {filtered.map((recruit) => (
                <RecruitRowView
                  key={recruit.name}
                  recruit={recruit}
                  active={recruit.name === selectedName}
                  onOpen={() => setSelectedName(recruit.name)}
                />
              ))}
              {filtered.length === 0 && (
                <div style={{ padding: 40, textAlign: "center", color: LB.textDim, fontSize: 12.5 }}>
                  No recruits match the current search / filters.
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );

  const detailPanel = selected && (
    <RecruitDetail
      recruit={selected}
      wide={detailInline}
      onClose={() => setSelectedName(null)}
      onPatched={onPatched}
      onDeleted={onDeleted}
    />
  );

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
        <button
          type="button"
          onClick={onBack}
          aria-label="Back to chat"
          title="Back to chat"
          style={{
            width: 30,
            height: 30,
            borderRadius: 8,
            border: `1px solid ${LB.border}`,
            background: LB.surface,
            color: LB.textMid,
            cursor: "pointer",
            fontSize: 15,
            lineHeight: 1,
          }}
        >
          ‹
        </button>
        <span style={{ fontSize: 14, fontWeight: 700, color: LB.text }}>Recruits</span>
        {summary && (
          <span style={{ fontFamily: FONTS.mono, fontSize: 10.5, color: LB.textDim }}>
            {summary.db_total} total · {summary.db_saturated} saturated · {summary.db_unsaturated} in progress
          </span>
        )}
        <span style={{ marginLeft: "auto" }}>
          <button
            type="button"
            onClick={() => void load(true)}
            disabled={refreshing}
            style={{ ...headerButtonStyle, opacity: refreshing ? 0.6 : 1 }}
          >
            {refreshing ? "Refreshing…" : "Refresh"}
          </button>
        </span>
      </header>

      <div style={{ flex: 1, display: "flex", minHeight: 0, padding: "14px 20px 20px", gap: 16, position: "relative" }}>
        {roster}

        {detailInline && (
          <div style={{
            flex: 1,
            minWidth: 0,
            minHeight: 0,
            border: `1px solid ${LB.border}`,
            borderRadius: 12,
            overflow: "hidden",
            background: LB.surface,
          }}>
            {detailPanel ?? (
              <div style={{
                height: "100%",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: LB.textDim,
                fontSize: 13,
              }}>
                Select a recruit to view their profile.
              </div>
            )}
          </div>
        )}

        {detailPanel && !detailInline && (
          <div
            onClick={() => setSelectedName(null)}
            style={{ position: "absolute", inset: 0, zIndex: 40, background: "rgba(17,17,17,0.28)" }}
          >
            <div
              onClick={(event) => event.stopPropagation()}
              style={{
                position: "absolute",
                top: 0,
                right: 0,
                bottom: 0,
                width: "min(400px, 92vw)",
                borderLeft: `1px solid ${LB.border}`,
                background: LB.surface,
              }}
            >
              {detailPanel}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
