/**
 * Evidenzklassen und zentrales Scoring für Multi-Source-RAG.
 */
import type { StageEvidenceItem } from "@/lib/knowledge/multiSourceSearch/types";

export type EvidenceType =
  | "MASTER_DATA_BUSINESS_FIELD"
  | "MASTER_DATA_BUSINESS_VALUE"
  | "EXACT_CODE_USAGE"
  | "EXACT_VALUE_CONDITION"
  | "RELATIONSHIP_EVIDENCE"
  | "SEMANTIC_CANDIDATE";

/** Zentral konfigurierbare Score-Werte. */
export const EVIDENCE_SCORES: Record<string, number> = {
  MASTER_DATA_BUSINESS_FIELD: 100,
  MASTER_DATA_BUSINESS_VALUE: 80,
  EXACT_CODE_USAGE: 100,
  EXACT_VALUE_CONDITION: 90,
  RELATIONSHIP_EVIDENCE: 70,
  SEMANTIC_CANDIDATE: 20,
  GENERIC_FIELD_WITHOUT_VALUE: 0,
  UNSPECIFIC_STANDARD_FIELD: -10,
  NO_RAW_CANONICAL_SOURCE: -30,
};

const EVIDENCE_TYPE_RANK: Record<EvidenceType, number> = {
  MASTER_DATA_BUSINESS_FIELD: 0,
  MASTER_DATA_BUSINESS_VALUE: 1,
  EXACT_CODE_USAGE: 2,
  EXACT_VALUE_CONDITION: 3,
  RELATIONSHIP_EVIDENCE: 4,
  SEMANTIC_CANDIDATE: 5,
};

export function evidenceScore(evidenceType: EvidenceType): number {
  return EVIDENCE_SCORES[evidenceType] ?? 0;
}

export function rankTierToEvidenceType(
  item: StageEvidenceItem,
): EvidenceType {
  if (item.evidence_type) return item.evidence_type;

  const source = item.source;
  if (source === "master_data") {
    if (item.rank_tier === "exact") return "MASTER_DATA_BUSINESS_FIELD";
    if (item.rank_tier === "value_check") return "MASTER_DATA_BUSINESS_VALUE";
  }
  if (source === "relations") return "RELATIONSHIP_EVIDENCE";
  if (item.rank_tier === "exact") {
    if (
      source === "classes" ||
      source === "programs" ||
      source === "function_modules" ||
      source === "exact_symbol"
    ) {
      return "EXACT_CODE_USAGE";
    }
    if (source === "control_tables") return "EXACT_VALUE_CONDITION";
    if (source === "master_data") return "MASTER_DATA_BUSINESS_FIELD";
  }
  if (item.rank_tier === "value_check") return "EXACT_VALUE_CONDITION";
  if (item.rank_tier === "relation") return "RELATIONSHIP_EVIDENCE";
  return "SEMANTIC_CANDIDATE";
}

export function scoreEvidenceItem(item: StageEvidenceItem): number {
  const evidenceType = rankTierToEvidenceType(item);
  let score = evidenceScore(evidenceType);
  score += item.confidence * 10;
  if (!item.path_hint) score += EVIDENCE_SCORES.NO_RAW_CANONICAL_SOURCE;
  return score;
}

export function compareEvidenceItems(
  a: StageEvidenceItem,
  b: StageEvidenceItem,
): number {
  const ta = rankTierToEvidenceType(a);
  const tb = rankTierToEvidenceType(b);
  const tr = EVIDENCE_TYPE_RANK[ta] - EVIDENCE_TYPE_RANK[tb];
  if (tr !== 0) return tr;
  return scoreEvidenceItem(b) - scoreEvidenceItem(a);
}
