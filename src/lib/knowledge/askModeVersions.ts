/**
 * Browser-safe version strings + index fingerprint for ask session cache.
 * Keep free of node:fs / node:crypto so client components can import this.
 */

export const PLANNED_RAG_PLANNER_VERSION = "planned-topic-ground-v1";
export const FULL_ANALYSIS_VERSION = "full-analysis-v1";
export const DEEP_SEARCH_VERSION = "deep-search-qu-v1";

/** FNV-1a 32-bit → 8 hex chars, doubled for a stable 16-char fingerprint. */
function fnv1aHex8(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * Deterministic short hash of active index path + document count.
 * Works in browser and Node (no node:crypto).
 */
export function computeActiveIndexHash(params: {
  indexPath: string;
  documentCount?: number;
}): string {
  const raw = `${params.indexPath}|${params.documentCount ?? 0}`;
  return `${fnv1aHex8(raw)}${fnv1aHex8(`~${raw}`)}`;
}
