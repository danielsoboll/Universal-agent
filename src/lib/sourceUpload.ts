export const SOURCE_ORIGINALS_BUCKET = "source-originals";

/** Matches private bucket file_size_limit (100 MiB). */
export const MAX_SOURCE_UPLOAD_BYTES = 100 * 1024 * 1024;

export const ALLOWED_SOURCE_EXTENSIONS = [
  ".jsonl",
  ".txt",
  ".json",
  ".csv",
  ".pdf",
] as const;

export type AllowedSourceExtension = (typeof ALLOWED_SOURCE_EXTENSIONS)[number];

const EXTENSION_TO_SOURCE_TYPE: Record<
  AllowedSourceExtension,
  "jsonl" | "txt" | "json" | "csv" | "pdf"
> = {
  ".jsonl": "jsonl",
  ".txt": "txt",
  ".json": "json",
  ".csv": "csv",
  ".pdf": "pdf",
};

export function getAllowedExtension(filename: string): AllowedSourceExtension | null {
  const lower = filename.toLowerCase();
  for (const ext of ALLOWED_SOURCE_EXTENSIONS) {
    if (lower.endsWith(ext)) return ext;
  }
  return null;
}

export function detectAllowedSourceType(filename: string) {
  const ext = getAllowedExtension(filename);
  return ext ? EXTENSION_TO_SOURCE_TYPE[ext] : null;
}

/** Safe object name for storage; original name stays in metadata. */
export function sanitizeFilename(original: string): string {
  const trimmed = original.trim() || "upload.bin";
  const cleaned = trimmed
    .replace(/[/\\]/g, "_")
    .replace(/[^\w.\-()+ äöüÄÖÜß]/g, "_")
    .replace(/_+/g, "_")
    .slice(0, 180);
  return cleaned || "upload.bin";
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || Number.isNaN(bytes)) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatUploadLimit(): string {
  return formatBytes(MAX_SOURCE_UPLOAD_BYTES);
}
