import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { LB, FONTS } from "../lb";
import { formatRelativeTime } from "../chat/theme";
import {
  RECRUIT_STATUSES,
  deleteRecruit,
  patchRecruit,
  structuredEnrichment,
  type Recruit,
  type RecruitStatus,
} from "./api";
import { Avatar, PIPELINE_STEPS, STATUS_META, StatusPill, fieldStyle, monoLabelStyle, stepDone } from "./ui";

/**
 * Everything-we-know viewer for one recruit, laid out like the merch studio's
 * design stage: hero header, a big merch canvas with thumbnail picker, then
 * profile sections. In `wide` mode (inline right pane) content splits into a
 * main column and a manage/contact side rail; narrow mode (mobile overlay)
 * stacks everything in one column.
 */

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section style={{ marginTop: 18 }}>
      <div style={{ ...monoLabelStyle, marginBottom: 7 }}>{label}</div>
      {children}
    </section>
  );
}

function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      style={{ color: LB.blue, fontSize: 12.5, textDecoration: "none", wordBreak: "break-all" }}
    >
      {children} ↗
    </a>
  );
}

const chipStyle: CSSProperties = {
  display: "inline-block",
  padding: "3px 9px",
  borderRadius: 999,
  background: LB.surfaceAlt,
  border: `1px solid ${LB.border}`,
  color: LB.textMid,
  fontSize: 11.5,
  fontWeight: 500,
};

/** "2019-06" / "2019-06-01" → "Jun 2019"; null → "Present". */
function formatYearMonth(value: string | null | undefined, fallback: string): string {
  if (!value) return fallback;
  const match = /^(\d{4})(?:-(\d{2}))?/.exec(value);
  if (!match) return value;
  if (!match[2]) return match[1];
  const month = new Date(Number(match[1]), Number(match[2]) - 1).toLocaleDateString(undefined, { month: "short" });
  return `${month} ${match[1]}`;
}

/** Merch canvas: one big stage image plus a thumbnail strip to switch between
 * the flat design and each mockup — the merch studio's preview, embedded. */
function MerchShowcase({ recruit, wide }: { recruit: Recruit; wide: boolean }) {
  const images = useMemo(() => {
    const out: { url: string; label: string }[] = [];
    if (recruit.design_image_url) out.push({ url: recruit.design_image_url, label: "Flat design" });
    for (const [index, url] of recruit.mockup_images.entries()) {
      out.push({ url, label: `Mockup ${index + 1}` });
    }
    return out;
  }, [recruit.design_image_url, recruit.mockup_images]);

  // Lead with a mockup when there is one — that's the "on the product" shot.
  const [activeIndex, setActiveIndex] = useState(0);
  useEffect(() => {
    setActiveIndex(recruit.design_image_url && recruit.mockup_images.length > 0 ? 1 : 0);
  }, [recruit.name, recruit.design_image_url, recruit.mockup_images.length]);

  const active = images[Math.min(activeIndex, images.length - 1)];

  if (images.length === 0 && !recruit.printify_product_url) {
    return (
      <div style={{
        padding: "28px 16px",
        borderRadius: 12,
        border: `1px dashed ${LB.borderStrong}`,
        background: LB.surfaceAlt,
        textAlign: "center",
        color: LB.textDim,
        fontSize: 12.5,
        lineHeight: 1.6,
      }}>
        No merch yet.
        <br />
        Ask the agent to design something for {recruit.name.split(/\s+/)[0]}.
      </div>
    );
  }

  return (
    <div>
      {active && (
        <a
          href={active.url}
          target="_blank"
          rel="noreferrer"
          title={`${active.label} — open full size`}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            height: wide ? 340 : 240,
            borderRadius: 12,
            border: `1px solid ${LB.border}`,
            background: LB.surfaceAlt,
            overflow: "hidden",
          }}
        >
          <img
            src={active.url}
            alt={active.label}
            style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }}
          />
        </a>
      )}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
        {images.length > 1 && images.map((image, index) => (
          <button
            key={image.url}
            type="button"
            onClick={() => setActiveIndex(index)}
            title={image.label}
            style={{
              width: 56,
              height: 56,
              padding: 0,
              borderRadius: 10,
              border: `2px solid ${index === activeIndex ? LB.blue : LB.border}`,
              background: LB.surfaceAlt,
              cursor: "pointer",
              overflow: "hidden",
              flexShrink: 0,
            }}
          >
            <img
              src={image.url}
              alt={image.label}
              style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
            />
          </button>
        ))}
        {recruit.printify_product_url && (
          <span style={{ marginLeft: "auto" }}>
            <ExternalLink href={recruit.printify_product_url}>
              View in Printify{recruit.printify_product_id ? ` (${recruit.printify_product_id})` : ""}
            </ExternalLink>
          </span>
        )}
      </div>
    </div>
  );
}

export function RecruitDetail({
  recruit,
  wide = false,
  onClose,
  onPatched,
  onDeleted,
}: {
  recruit: Recruit;
  wide?: boolean;
  onClose: () => void;
  onPatched: (name: string, patch: Partial<Recruit>) => void;
  onDeleted: (name: string) => void;
}) {
  const enrichment = structuredEnrichment(recruit);
  const [companyDraft, setCompanyDraft] = useState(recruit.company ?? "");
  const [notesDraft, setNotesDraft] = useState(recruit.notes ?? "");
  const [saving, setSaving] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset drafts when the selected recruit changes.
  useEffect(() => {
    setCompanyDraft(recruit.company ?? "");
    setNotesDraft(recruit.notes ?? "");
    setConfirmingDelete(false);
    setError(null);
  }, [recruit.name]);

  const dirty = companyDraft.trim() !== (recruit.company ?? "")
    || notesDraft.trim() !== (recruit.notes ?? "");

  const runPatch = async (patch: Partial<Pick<Recruit, "company" | "linkedin_url" | "status" | "notes">>) => {
    setSaving(true);
    setError(null);
    try {
      await patchRecruit(recruit.name, patch);
      onPatched(recruit.name, patch);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const saveDrafts = () => {
    // Edit_recruits can't null fields out — only send non-empty values.
    const patch: Partial<Pick<Recruit, "company" | "notes">> = {};
    if (companyDraft.trim() && companyDraft.trim() !== (recruit.company ?? "")) patch.company = companyDraft.trim();
    if (notesDraft.trim() && notesDraft.trim() !== (recruit.notes ?? "")) patch.notes = notesDraft.trim();
    if (Object.keys(patch).length > 0) void runPatch(patch);
  };

  const removeRecruit = async () => {
    setSaving(true);
    setError(null);
    try {
      await deleteRecruit(recruit.name);
      onDeleted(recruit.name);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSaving(false);
    }
  };

  const links = useMemo(() => {
    const out: { label: string; href: string }[] = [];
    const push = (label: string, href: string | null | undefined) => {
      if (href) out.push({ label, href });
    };
    push("LinkedIn", recruit.linkedin_url ?? enrichment?.links?.linkedin);
    push("GitHub", enrichment?.links?.github);
    push("Twitter", enrichment?.links?.twitter);
    push("Facebook", enrichment?.links?.facebook);
    push("Website", enrichment?.links?.website);
    return out;
  }, [recruit, enrichment]);

  const headline = enrichment?.headline
    || [enrichment?.current_title, enrichment?.current_company].filter(Boolean).join(" · ")
    || null;

  const errorBanner = error && (
    <div style={{
      marginTop: 12,
      padding: "8px 10px",
      borderRadius: 8,
      background: LB.redSoft,
      color: LB.red,
      fontSize: 12,
    }}>
      {error}
    </div>
  );

  const merchSection = (
    <Section label="Merch">
      <MerchShowcase recruit={recruit} wide={wide} />
    </Section>
  );

  const experienceSection = enrichment && (enrichment.experience?.length ?? 0) > 0 && (
    <Section label="Experience">
      <div style={{ display: "grid", gap: 10 }}>
        {(enrichment.experience ?? []).map((role, index) => (
          <div key={index}>
            <div style={{ fontSize: 12.5, fontWeight: 600, color: LB.text }}>
              {role.title ?? "—"}
              {role.company && <span style={{ fontWeight: 500, color: LB.textMid }}> · {role.company}</span>}
            </div>
            <div style={{ fontFamily: FONTS.mono, fontSize: 10.5, color: LB.textDim, marginTop: 1 }}>
              {formatYearMonth(role.start, "?")} — {formatYearMonth(role.end, "Present")}
            </div>
          </div>
        ))}
      </div>
    </Section>
  );

  const educationSection = enrichment && (enrichment.education?.length ?? 0) > 0 && (
    <Section label="Education">
      <div style={{ display: "grid", gap: 10 }}>
        {(enrichment.education ?? []).map((school, index) => (
          <div key={index}>
            <div style={{ fontSize: 12.5, fontWeight: 600, color: LB.text }}>{school.school ?? "—"}</div>
            {(school.degrees?.length || school.majors?.length) ? (
              <div style={{ fontSize: 12, color: LB.textMid, marginTop: 1 }}>
                {[...(school.degrees ?? []), ...(school.majors ?? [])].join(", ")}
              </div>
            ) : null}
            <div style={{ fontFamily: FONTS.mono, fontSize: 10.5, color: LB.textDim, marginTop: 1 }}>
              {[formatYearMonth(school.end, ""), school.gpa != null ? `GPA ${school.gpa}` : ""].filter(Boolean).join(" · ")}
            </div>
          </div>
        ))}
      </div>
    </Section>
  );

  const skillsSection = enrichment && (enrichment.skills?.length ?? 0) > 0 && (
    <Section label="Skills">
      <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
        {(enrichment.skills ?? []).map((skill) => (
          <span key={skill} style={chipStyle}>{skill}</span>
        ))}
      </div>
    </Section>
  );

  const rawSection = recruit.enrichment != null && (
    <Section label="Raw enrichment">
      <details>
        <summary style={{ cursor: "pointer", fontSize: 12, color: LB.textDim }}>
          Full JSON payload
        </summary>
        <pre style={{
          marginTop: 8,
          padding: 10,
          borderRadius: 8,
          background: LB.surfaceAlt,
          border: `1px solid ${LB.border}`,
          fontFamily: FONTS.mono,
          fontSize: 10.5,
          lineHeight: 1.5,
          color: LB.textMid,
          overflowX: "auto",
          maxHeight: 320,
          overflowY: "auto",
        }}>
          {typeof recruit.enrichment === "string"
            ? recruit.enrichment
            : JSON.stringify(recruit.enrichment, null, 2)}
        </pre>
      </details>
    </Section>
  );

  const pipelineSection = (
    <Section label="Pipeline">
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {PIPELINE_STEPS.map((step) => {
          const done = stepDone(recruit, step.key);
          return (
            <span
              key={step.key}
              title={done ? `${step.label}: done` : `${step.label}: missing`}
              style={{
                ...chipStyle,
                display: "inline-flex",
                alignItems: "center",
                gap: 5,
                background: done ? LB.greenSoft : LB.surfaceAlt,
                color: done ? LB.green : LB.textDim,
                fontFamily: FONTS.mono,
                fontSize: 10.5,
              }}
            >
              {done ? "●" : "○"} {step.label}
            </span>
          );
        })}
      </div>
    </Section>
  );

  const manageSection = (
    <Section label="Manage">
      <div style={{ display: "grid", gap: 10 }}>
        <div>
          <label style={{ ...monoLabelStyle, display: "block", marginBottom: 3 }}>Status</label>
          <select
            value={recruit.status}
            disabled={saving}
            onChange={(event) => void runPatch({ status: event.target.value as RecruitStatus })}
            style={{ ...fieldStyle, cursor: "pointer" }}
          >
            {RECRUIT_STATUSES.map((status) => (
              <option key={status} value={status}>{STATUS_META[status].label}</option>
            ))}
          </select>
        </div>
        <div>
          <label style={{ ...monoLabelStyle, display: "block", marginBottom: 3 }}>Company</label>
          <input
            value={companyDraft}
            placeholder="Company being courted for"
            onChange={(event) => setCompanyDraft(event.target.value)}
            style={fieldStyle}
          />
        </div>
        <div>
          <label style={{ ...monoLabelStyle, display: "block", marginBottom: 3 }}>Notes</label>
          <textarea
            value={notesDraft}
            placeholder="Agent / recruiter notes"
            onChange={(event) => setNotesDraft(event.target.value)}
            rows={3}
            style={{ ...fieldStyle, height: "auto", padding: "8px 10px", resize: "vertical", lineHeight: 1.5 }}
          />
        </div>
        {dirty && (
          <button
            type="button"
            disabled={saving}
            onClick={saveDrafts}
            style={{
              height: 32,
              border: "none",
              borderRadius: 8,
              background: LB.blue,
              color: "#FFF",
              fontSize: 12.5,
              fontWeight: 700,
              cursor: saving ? "default" : "pointer",
              opacity: saving ? 0.6 : 1,
              justifySelf: "start",
              padding: "0 16px",
            }}
          >
            {saving ? "Saving…" : "Save changes"}
          </button>
        )}
      </div>
    </Section>
  );

  const contactSection = enrichment && ((enrichment.emails?.length ?? 0) > 0 || (enrichment.phones?.length ?? 0) > 0) && (
    <Section label="Contact">
      <div style={{ display: "grid", gap: 4 }}>
        {(enrichment.emails ?? []).map((email) => (
          <ExternalLink key={email} href={`mailto:${email}`}>{email}</ExternalLink>
        ))}
        {(enrichment.phones ?? []).map((phone) => (
          <span key={phone} style={{ fontFamily: FONTS.mono, fontSize: 12, color: LB.textMid }}>{phone}</span>
        ))}
      </div>
    </Section>
  );

  const linksSection = links.length > 0 && (
    <Section label="Links">
      <div style={{ display: "grid", gap: 4 }}>
        {links.map((link) => (
          <ExternalLink key={link.label} href={link.href}>{link.label}</ExternalLink>
        ))}
      </div>
    </Section>
  );

  const profileSection = enrichment && (enrichment.industry || enrichment.current_title || enrichment.current_company) && (
    <Section label="Profile">
      <div style={{ display: "grid", gap: 4, fontSize: 12.5, color: LB.textMid }}>
        {enrichment.current_title && <div>Title: {enrichment.current_title}</div>}
        {enrichment.current_company && <div>Company: {enrichment.current_company}</div>}
        {enrichment.industry && <div>Industry: {enrichment.industry}</div>}
      </div>
    </Section>
  );

  const recordSection = (
    <Section label="Record">
      <div style={{ display: "grid", gap: 3, fontFamily: FONTS.mono, fontSize: 10.5, color: LB.textDim }}>
        {recruit.created_at && <span>created {formatRelativeTime(recruit.created_at)}</span>}
        <span>updated {formatRelativeTime(recruit.updated_at)}</span>
      </div>
      <button
        type="button"
        disabled={saving}
        onClick={() => (confirmingDelete ? void removeRecruit() : setConfirmingDelete(true))}
        onBlur={() => setConfirmingDelete(false)}
        style={{
          marginTop: 12,
          height: 30,
          padding: "0 12px",
          borderRadius: 8,
          border: `1px solid ${confirmingDelete ? LB.red : LB.border}`,
          background: confirmingDelete ? LB.redSoft : LB.surface,
          color: LB.red,
          fontSize: 12,
          fontWeight: 600,
          cursor: "pointer",
        }}
      >
        {confirmingDelete ? "Confirm delete" : "Delete recruit"}
      </button>
    </Section>
  );

  return (
    <div style={{
      display: "flex",
      flexDirection: "column",
      height: "100%",
      minHeight: 0,
      background: LB.surface,
    }}>
      <header style={{
        display: "flex",
        alignItems: "flex-start",
        gap: wide ? 16 : 12,
        padding: wide ? "20px 24px 16px" : "16px 18px 14px",
        borderBottom: `1px solid ${LB.border}`,
      }}>
        <Avatar recruit={recruit} size={wide ? 64 : 52} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: wide ? 19 : 15.5, fontWeight: 700, color: LB.text, lineHeight: 1.25 }}>
            {recruit.name}
          </div>
          {headline && (
            <div style={{ fontSize: wide ? 13 : 12, color: LB.textDim, marginTop: 2, lineHeight: 1.4 }}>
              {headline}
            </div>
          )}
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 7, flexWrap: "wrap" }}>
            <StatusPill status={recruit.status} />
            {enrichment?.location && (
              <span style={{ fontFamily: FONTS.mono, fontSize: 10.5, color: LB.textDim }}>
                {enrichment.location}
              </span>
            )}
            {wide && (recruit.company ?? enrichment?.current_company) && (
              <span style={{ fontFamily: FONTS.mono, fontSize: 10.5, color: LB.textDim }}>
                · {recruit.company ?? enrichment?.current_company}
              </span>
            )}
          </div>
        </div>
        {!wide && (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close details"
            style={{
              width: 28,
              height: 28,
              borderRadius: 8,
              border: `1px solid ${LB.border}`,
              background: LB.surface,
              color: LB.textMid,
              cursor: "pointer",
              fontSize: 13,
              lineHeight: 1,
              flexShrink: 0,
            }}
          >
            ✕
          </button>
        )}
      </header>

      <div style={{ flex: 1, overflowY: "auto", padding: wide ? "4px 24px 24px" : "4px 18px 20px" }}>
        {errorBanner}

        {wide ? (
          <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 320px", gap: 28, alignItems: "start" }}>
            <div style={{ minWidth: 0 }}>
              {merchSection}
              {experienceSection}
              {educationSection}
              {skillsSection}
              {rawSection}
            </div>
            <div style={{ minWidth: 0 }}>
              {pipelineSection}
              {manageSection}
              {contactSection}
              {linksSection}
              {profileSection}
              {recordSection}
            </div>
          </div>
        ) : (
          <>
            {pipelineSection}
            {manageSection}
            {merchSection}
            {contactSection}
            {linksSection}
            {skillsSection}
            {experienceSection}
            {educationSection}
            {profileSection}
            {rawSection}
          </>
        )}
      </div>
    </div>
  );
}
