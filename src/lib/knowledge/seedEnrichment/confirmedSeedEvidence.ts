/**
 * Helpers for confirmed deterministic seed-enrichment evidence.
 * Generic — no object-/customer-specific vocabulary.
 */
import type { KnowledgeHit } from "@/lib/knowledge/types";

/** Hit produced by deterministic seed enrichment (not lexical/semantic alone). */
export function isConfirmedSeedEvidenceHit(hit: KnowledgeHit): boolean {
  if (hit.metadata?.seed_enrichment === true) return true;
  if (
    (hit.matched_terms ?? []).some(
      (t) => String(t).toLowerCase() === "seed_enrichment",
    )
  ) {
    return true;
  }
  const id = String(hit.search_document_id ?? "");
  if (id.startsWith("enrichment:")) return true;
  return false;
}

/**
 * Confirmed seed hit with real deterministic payload (instances / usage / values).
 * Empty stubs (DDIC-only or zero-count) are not protected.
 */
export function hasDeterministicSeedEvidence(hit: KnowledgeHit): boolean {
  if (!isConfirmedSeedEvidenceHit(hit)) return false;
  const facts = hit.facts ?? [];
  const evidenceTexts = (hit.evidence ?? []).map((e) => e.text ?? "");
  const blob = [...facts, ...evidenceTexts, hit.snippet ?? "", hit.technical_summary ?? ""]
    .join("\n");
  if (!blob.trim()) return false;

  // Positive instance / value / code-usage signals (generic German+EN patterns).
  const hasPositiveCount =
    /\b([1-9]\d*)\s*(?:×|x|Kunden|Instanzen|Zuordnungen|Links|Attribute)\b/i.test(
      blob,
    ) ||
    /\bist bei ([1-9]\d*)\b/i.test(blob) ||
    /\bCode-Usage[^0-9]*([1-9]\d*)/i.test(blob) ||
    /\bBeobachtete Werte[^0-9]*\w+[^\n]*\(([1-9]\d*)/i.test(blob) ||
    /\bBeispiel:\b/i.test(blob);

  if (hasPositiveCount) return true;

  // At least two concrete facts beyond a single empty stub line.
  if (facts.length >= 2 && evidenceTexts.length >= 1) return true;
  return false;
}

/**
 * Merge synthesis hit lists while keeping confirmed seed evidence present.
 * Seed hits stay ahead of non-seed hits; relative order within groups preserved.
 */
export function mergePreserveConfirmedSeedEvidence(
  primary: KnowledgeHit[],
  allHits: KnowledgeHit[],
): KnowledgeHit[] {
  const seed = allHits.filter(hasDeterministicSeedEvidence);
  if (seed.length === 0) return primary;
  const seen = new Set<string>();
  const out: KnowledgeHit[] = [];
  for (const h of [...seed, ...primary]) {
    const id = h.search_document_id;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(h);
  }
  return out.map((h, i) => ({ ...h, rank: i + 1 }));
}
