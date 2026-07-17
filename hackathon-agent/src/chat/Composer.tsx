import { useCallback, useEffect, useRef, useState, type ChangeEvent, type ClipboardEvent, type DragEvent } from "react";
import { LB, FONTS } from "../lb";
import { formatBytes, MAX_MESSAGE_IMAGES, prepareImage, releasePreview, type PendingImage } from "./images";

export function Composer({
  disabled,
  isStreaming,
  onSend,
  onStop,
  connectionLabel,
}: {
  disabled: boolean;
  isStreaming: boolean;
  onSend: (text: string, images: PendingImage[]) => void;
  onStop: () => void;
  connectionLabel: string | null;
}) {
  const [text, setText] = useState("");
  const [images, setImages] = useState<PendingImage[]>([]);
  const [dragging, setDragging] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const resize = useCallback(() => {
    const node = textareaRef.current;
    if (!node) return;
    node.style.height = "0px";
    node.style.height = `${Math.min(180, Math.max(44, node.scrollHeight))}px`;
  }, []);
  useEffect(resize, [text, resize]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(timer);
  }, [notice]);

  const addFiles = useCallback((files: File[]) => {
    const imageFiles = files.filter((file) =>
      file.type.startsWith("image/")
      || /\.(heic|heif|avif|pdf|csv)$/i.test(file.name)
      || file.type === "application/pdf"
      || file.type === "text/csv");
    if (imageFiles.length < files.length) {
      setNotice("Only images, PDFs, and CSVs can be attached.");
    }
    if (imageFiles.length === 0) return;
    void (async () => {
      for (const file of imageFiles) {
        let full = false;
        setImages((current) => {
          full = current.length >= MAX_MESSAGE_IMAGES;
          return current;
        });
        if (full) {
          setNotice(`At most ${MAX_MESSAGE_IMAGES} attachments per message.`);
          break;
        }
        try {
          const prepared = await prepareImage(file);
          setImages((current) =>
            current.length >= MAX_MESSAGE_IMAGES ? current : [...current, prepared]);
        } catch (error) {
          setNotice(error instanceof Error ? error.message : "Couldn't read that image.");
        }
      }
    })();
  }, []);

  const onPickFiles = (event: ChangeEvent<HTMLInputElement>) => {
    addFiles(Array.from(event.target.files ?? []));
    event.target.value = "";
  };

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData?.files ?? []);
    if (files.length > 0) {
      event.preventDefault();
      addFiles(files.map((file, index) => file.name
        ? file
        : new File([file], `pasted-image-${Date.now()}-${index}.png`, { type: file.type || "image/png" })));
    }
  };

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    addFiles(Array.from(event.dataTransfer?.files ?? []));
  };

  const canSend = !disabled && !isStreaming && (text.trim().length > 0 || images.length > 0);

  const submit = () => {
    if (!canSend) return;
    onSend(text.trim(), images);
    images.forEach(releasePreview);
    setText("");
    setImages([]);
  };

  return (
    <div style={{ padding: "0 20px 18px" }}>
      <div style={{ maxWidth: 760, margin: "0 auto" }}>
        {notice && (
          <div style={{
            marginBottom: 8,
            padding: "7px 11px",
            borderRadius: 9,
            background: LB.amberSoft,
            color: LB.amber,
            fontSize: 12.5,
          }}>
            {notice}
          </div>
        )}
        <div
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          style={{
            borderRadius: 16,
            border: `1.5px solid ${dragging ? LB.blue : LB.border}`,
            background: LB.surface,
            boxShadow: "0 6px 24px rgba(17,17,17,0.06)",
            transition: "border-color 120ms ease",
          }}
        >
          {images.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, padding: "10px 12px 0" }}>
              {images.map((image) => (
                <span
                  key={image.key}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 7,
                    height: 34,
                    padding: "0 9px 0 4px",
                    borderRadius: 8,
                    border: `1px solid ${LB.border}`,
                    background: LB.surfaceAlt,
                    fontSize: 12,
                    color: LB.textMid,
                  }}
                >
                  {!image.previewUrl ? (
                    <span style={{ width: 26, height: 26, display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 14 }}>
                      {image.mediaType === "text/csv" ? "🧾" : "📄"}
                    </span>
                  ) : (
                    <img
                      src={image.previewUrl}
                      alt={image.filename}
                      style={{ width: 26, height: 26, borderRadius: 5, objectFit: "cover" }}
                    />
                  )}
                  <span style={{ maxWidth: 140, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {image.filename}
                  </span>
                  <span style={{ fontFamily: FONTS.mono, fontSize: 10, color: LB.textDim }}>
                    {formatBytes(image.sizeBytes)}
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      releasePreview(image);
                      setImages((current) => current.filter((candidate) => candidate.key !== image.key));
                    }}
                    aria-label={`Remove ${image.filename}`}
                    style={{
                      border: "none",
                      background: "transparent",
                      color: "inherit",
                      cursor: "pointer",
                      fontSize: 13,
                      padding: 0,
                      lineHeight: 1,
                    }}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
          <div style={{ display: "flex", alignItems: "flex-end", gap: 8, padding: "8px 10px 8px 14px" }}>
            <textarea
              ref={textareaRef}
              value={text}
              placeholder={disabled ? "Connecting…" : "Message your agent…"}
              disabled={disabled}
              onChange={(event) => setText(event.target.value)}
              onPaste={onPaste}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  submit();
                }
              }}
              rows={1}
              style={{
                flex: 1,
                resize: "none",
                border: "none",
                outline: "none",
                background: "transparent",
                fontFamily: "inherit",
                fontSize: 14.5,
                lineHeight: 1.55,
                color: LB.text,
                padding: "9px 0",
                maxHeight: 180,
              }}
            />
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept="image/*,application/pdf,.pdf,text/csv,.csv"
              onChange={onPickFiles}
              style={{ display: "none" }}
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={disabled}
              title="Attach images, PDFs, or CSVs"
              aria-label="Attach images, PDFs, or CSVs"
              style={{
                width: 34,
                height: 34,
                borderRadius: 10,
                border: `1px solid ${LB.border}`,
                background: LB.surface,
                color: LB.textDim,
                cursor: disabled ? "default" : "pointer",
                fontSize: 15,
                flexShrink: 0,
              }}
            >
              ⌁
            </button>
            {isStreaming ? (
              <button
                type="button"
                onClick={onStop}
                title="Stop generating"
                aria-label="Stop generating"
                style={{
                  width: 34,
                  height: 34,
                  borderRadius: 10,
                  border: `1px solid ${LB.text}`,
                  background: LB.text,
                  color: "#FFF",
                  cursor: "pointer",
                  flexShrink: 0,
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <span style={{ width: 11, height: 11, background: "#FFF", borderRadius: 2.5 }} />
              </button>
            ) : (
              <button
                type="button"
                onClick={submit}
                disabled={!canSend}
                title="Send"
                aria-label="Send"
                style={{
                  width: 34,
                  height: 34,
                  borderRadius: 10,
                  border: "none",
                  background: canSend ? LB.blue : LB.slateSoft,
                  color: canSend ? "#FFF" : LB.textDim,
                  cursor: canSend ? "pointer" : "default",
                  fontSize: 15,
                  fontWeight: 700,
                  flexShrink: 0,
                  transition: "background 120ms ease",
                }}
              >
                ↑
              </button>
            )}
          </div>
          <div style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "0 14px 10px",
          }}>
            <span style={{ marginLeft: "auto", fontFamily: FONTS.mono, fontSize: 10.5, color: LB.textDim }}>
              {connectionLabel ?? "Enter to send · Shift+Enter for newline · paste or drop images/PDFs/CSVs"}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
