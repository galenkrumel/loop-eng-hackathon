import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { LB, FONTS } from "../lb";

const blockSpacing: React.CSSProperties = { margin: "0 0 10px" };

const markdownComponents = {
  a({ href, children }: { href?: string; children?: React.ReactNode }) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noreferrer noopener"
        style={{ color: LB.blue, textDecoration: "none", borderBottom: `1px solid ${LB.blueSoft}` }}
      >
        {children}
      </a>
    );
  },
  p({ children }: { children?: React.ReactNode }) {
    return <p style={{ ...blockSpacing, lineHeight: 1.62 }}>{children}</p>;
  },
  ul({ children }: { children?: React.ReactNode }) {
    return <ul style={{ ...blockSpacing, paddingLeft: 22, lineHeight: 1.62 }}>{children}</ul>;
  },
  ol({ children }: { children?: React.ReactNode }) {
    return <ol style={{ ...blockSpacing, paddingLeft: 22, lineHeight: 1.62 }}>{children}</ol>;
  },
  li({ children }: { children?: React.ReactNode }) {
    return <li style={{ margin: "3px 0" }}>{children}</li>;
  },
  h1({ children }: { children?: React.ReactNode }) {
    return <h3 style={{ margin: "16px 0 8px", fontSize: 17, fontWeight: 700 }}>{children}</h3>;
  },
  h2({ children }: { children?: React.ReactNode }) {
    return <h4 style={{ margin: "14px 0 7px", fontSize: 15.5, fontWeight: 700 }}>{children}</h4>;
  },
  h3({ children }: { children?: React.ReactNode }) {
    return <h5 style={{ margin: "12px 0 6px", fontSize: 14.5, fontWeight: 700 }}>{children}</h5>;
  },
  blockquote({ children }: { children?: React.ReactNode }) {
    return (
      <blockquote style={{
        ...blockSpacing,
        padding: "2px 0 2px 12px",
        borderLeft: `3px solid ${LB.borderStrong}`,
        color: LB.textMid,
      }}>
        {children}
      </blockquote>
    );
  },
  code({ className, children }: { className?: string; children?: React.ReactNode }) {
    const isBlock = typeof className === "string" && className.includes("language-");
    if (!isBlock) {
      return (
        <code style={{
          fontFamily: FONTS.mono,
          fontSize: "0.86em",
          background: LB.surfaceAlt,
          border: `1px solid ${LB.border}`,
          borderRadius: 5,
          padding: "1px 5px",
        }}>
          {children}
        </code>
      );
    }
    return <code style={{ fontFamily: FONTS.mono, fontSize: 12.5 }}>{children}</code>;
  },
  pre({ children }: { children?: React.ReactNode }) {
    return (
      <pre style={{
        ...blockSpacing,
        padding: "12px 14px",
        background: "#16160F",
        color: "#F3F2EA",
        borderRadius: 10,
        overflowX: "auto",
        lineHeight: 1.55,
      }}>
        {children}
      </pre>
    );
  },
  table({ children }: { children?: React.ReactNode }) {
    return (
      <div style={{ overflowX: "auto", ...blockSpacing }}>
        <table style={{ borderCollapse: "collapse", fontSize: 13, minWidth: 280 }}>{children}</table>
      </div>
    );
  },
  th({ children }: { children?: React.ReactNode }) {
    return (
      <th style={{
        textAlign: "left",
        padding: "6px 12px",
        borderBottom: `2px solid ${LB.borderStrong}`,
        fontWeight: 700,
        whiteSpace: "nowrap",
      }}>
        {children}
      </th>
    );
  },
  td({ children }: { children?: React.ReactNode }) {
    return <td style={{ padding: "6px 12px", borderBottom: `1px solid ${LB.border}`, verticalAlign: "top" }}>{children}</td>;
  },
  hr() {
    return <hr style={{ border: 0, borderTop: `1px solid ${LB.border}`, margin: "14px 0" }} />;
  },
};

export const ChatMarkdown = memo(function ChatMarkdown({ text }: { text: string }) {
  return (
    <div style={{ fontSize: 14.5, color: LB.text, overflowWrap: "anywhere" }}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
