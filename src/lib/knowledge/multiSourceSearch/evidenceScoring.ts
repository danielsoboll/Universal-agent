/**
 * Evidenzklassen und zentrales Scoring für Multi-Source-RAG.
 */
import type { StageEvidenceItem } from "@/lib/knowledge/multiSourceSearch/types";

export type EvidenceType =
  | "CONFIGURATION_OBJECT"
  | "MASTER_DATA_BUSINESS_FIELD"
  | "MASTER_DATA_BUSINESS_VALUE"
  | "EXACT_CODE_USAGE"
  | "EXACT_VALUE_CONDITION"
  | "RELATIONSHIP_EVIDENCE"
  | "SEMANTIC_CANDIDATE";

/** Zentral konfigurierbare Score-Werte. */
export const EVIDENCE_SCORES: Record<string, number> = {
  CONFIGURATION_OBJECT: 110,
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
  CONFIGURATION_OBJECT: 0,
  MASTER_DATA_BUSINESS_FIELD: 1,
  MASTER_DATA_BUSINESS_VALUE: 2,
  EXACT_CODE_USAGE: 3,
  EXACT_VALUE_CONDITION: 4,
  RELATIONSHIP_EVIDENCE: 5,
  SEMANTIC_CANDIDATE: 6,
};

export function evidenceScore(evidenceType: EvidenceType): number {
  return EVIDENCE_SCORES[evidenceType] ?? 0;
}

function looksLikeConfig(item: StageEvidenceItem): boolean {
  const path = (item.path_hint ?? "").toLowerCase();
  const title = (item.title ?? "").toLowerCase();
  if (path.includes("message-idoc-config")) return true;
  if (
    /^(output_type|output_processing|output_type_text|partner_profile|ale_message|idoc_)/i.test(
      title,
    )
  ) {
    return true;
  }
  if (item.evidence_type === "CONFIGURATION_OBJECT") return true;
  return false;
}

export function rankTierToEvidenceType(
  item: StageEvidenceItem,
): EvidenceType {
  if (item.evidence_type === "CONFIGURATION_OBJECT") {
    return "CONFIGURATION_OBJECT";
  }
  if (looksLikeConfig(item) && item.rank_tier === "exact") {
    return "CONFIGURATION_OBJECT";
  }
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
  // Boost exact key identity in title/object_name
  if (item.rank_tier === "exact" && item.related_to_symbol) score += 8;
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

/** Evidence category for reserved budgets. */
export type EvidenceCategory =
  | "configuration"
  | "code"
  | "relations"
  | "control"
  | "partner_master"
  | "other";

export const CATEGORY_BUDGETS: Record<
  EvidenceCategory,
  { min: number; max: number }
> = {
  configuration: { min: 4, max: 14 },
  code: { min: 6, max: 18 },
  relations: { min: 3, max: 10 },
  control: { min: 2, max: 8 },
  partner_master: { min: 2, max: 8 },
  other: { min: 0, max: 6 },
};

export function evidenceCategory(item: StageEvidenceItem): EvidenceCategory {
  const t = rankTierToEvidenceType(item);
  if (t === "CONFIGURATION_OBJECT" || looksLikeConfig(item)) {
    return "configuration";
  }
  if (
    item.source === "master_data" ||
    /partner/i.test(item.title) ||
    t === "MASTER_DATA_BUSINESS_FIELD" ||
    t === "MASTER_DATA_BUSINESS_VALUE"
  ) {
    return "partner_master";
  }
  if (item.source === "control_tables" || t === "EXACT_VALUE_CONDITION") {
    return "control";
  }
  if (item.source === "relations" || t === "RELATIONSHIP_EVIDENCE") {
    return "relations";
  }
  if (
    item.source === "programs" ||
    item.source === "classes" ||
    item.source === "function_modules" ||
    t === "EXACT_CODE_USAGE"
  ) {
    return "code";
  }
  if (item.source === "exact_symbol") {
    return looksLikeConfig(item) ? "configuration" : "code";
  }
  return "other";
}
