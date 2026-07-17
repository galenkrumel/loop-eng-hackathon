/**
 * Client-side attachment prep. Every attachment uploads to /api/uploads
 * (R2) FIRST and the chat message carries only the returned /files/ URL —
 * multi-MB data URLs inside messages crash the Durable Object's SQLite
 * persistence (~2MB row limit) and bloat the transcript. Images are still
 * downscaled to ≤1600px JPEG before upload; PDFs/CSVs upload as-is and are
 * text-extracted server-side.
 */

export type PendingImage = {
  key: string;
  filename: string;
  mediaType: string;
  /** What the message's file part carries — an /files/ R2 URL. */
  url: string;
  /** Local preview for the composer chip (images only). */
  previewUrl: string | null;
  sizeBytes: number;
};

export const MAX_MESSAGE_IMAGES = 6;
const MAX_DIMENSION = 1600;
const JPEG_QUALITY = 0.85;
const MAX_SOURCE_BYTES = 20 * 1024 * 1024;
const MAX_PDF_BYTES = 10 * 1024 * 1024;
const MAX_CSV_BYTES = 5 * 1024 * 1024;

export function isPdfFile(file: File): boolean {
  return file.type === "application/pdf" || /\.pdf$/i.test(file.name);
}

export function isCsvFile(file: File): boolean {
  return file.type === "text/csv" || file.type === "application/csv" || /\.csv$/i.test(file.name);
}

async function uploadToR2(blob: Blob, filename: string, mediaType: string): Promise<{ url: string; sizeBytes: number }> {
  const response = await fetch("/api/uploads", {
    method: "POST",
    headers: {
      "content-type": mediaType,
      "x-filename": encodeURIComponent(filename),
    },
    body: blob,
  });
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok || typeof payload.url !== "string") {
    throw new Error(typeof payload.error === "string" ? payload.error : `Upload failed (HTTP ${response.status}).`);
  }
  return { url: payload.url, sizeBytes: typeof payload.size_bytes === "number" ? payload.size_bytes : blob.size };
}

/** Downscale an image to a JPEG blob; null when the browser can't decode it. */
async function downscaleImage(file: File): Promise<Blob | null> {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_DIMENSION / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();
    return await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", JPEG_QUALITY));
  } catch {
    return null;
  }
}

export async function prepareImage(file: File): Promise<PendingImage> {
  const key = `${file.name}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  if (isPdfFile(file)) {
    if (file.size > MAX_PDF_BYTES) throw new Error(`"${file.name}" is over the 10 MB PDF limit.`);
    const uploaded = await uploadToR2(file, file.name, "application/pdf");
    return { key, filename: file.name, mediaType: "application/pdf", url: uploaded.url, previewUrl: null, sizeBytes: uploaded.sizeBytes };
  }

  if (isCsvFile(file)) {
    if (file.size > MAX_CSV_BYTES) throw new Error(`"${file.name}" is over the 5 MB CSV limit.`);
    // Browsers may type .csv as text/plain or vnd.ms-excel — normalize so
    // the worker's CSV branch always matches.
    const uploaded = await uploadToR2(file, file.name, "text/csv");
    return { key, filename: file.name, mediaType: "text/csv", url: uploaded.url, previewUrl: null, sizeBytes: uploaded.sizeBytes };
  }

  if (!file.type.startsWith("image/") && !/\.(heic|heif|avif)$/i.test(file.name)) {
    throw new Error(`"${file.name}" isn't an image, PDF, or CSV.`);
  }
  if (file.size > MAX_SOURCE_BYTES) {
    throw new Error(`"${file.name}" is over the 20 MB limit.`);
  }

  const downscaled = await downscaleImage(file);
  // Undecodable formats (e.g. HEIC in some browsers) upload raw — the model
  // may still accept them.
  const blob = downscaled ?? file;
  const mediaType = downscaled ? "image/jpeg" : (file.type || "application/octet-stream");
  const uploaded = await uploadToR2(blob, file.name, mediaType);
  return {
    key,
    filename: file.name,
    mediaType,
    url: uploaded.url,
    previewUrl: URL.createObjectURL(blob),
    sizeBytes: uploaded.sizeBytes,
  };
}

export function releasePreview(image: PendingImage): void {
  if (image.previewUrl) URL.revokeObjectURL(image.previewUrl);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
