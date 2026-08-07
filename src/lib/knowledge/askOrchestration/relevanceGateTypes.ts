/**
 * Orchestration relevance gate — filter graph/config noise before synthesis.
 * Generic: no question- or object-name hardcoding.
 */

export type RelevanceFlags = {
  exact_symbol_match: boolean;
  direct_edge_to_seed: boolean;
  graph_distance: number | null;
  authoritative_relation: boolean;
  same_code_unit: boolean;
  same_class_or_program: boolean;
  semantic_only: boolean;
  shared_token_only: boolean;
};

export type EvidenceTier = "PRIMARY" | "SECONDARY" | "EXCLUDED";

export type EvidenceCandidateKind =
  | "CODE_UNIT"
  | "AUTHORITATIVE_NODE"
  | "ANALYSIS"
  | "FIELD_REF"
  | "QUERY_TERM";

export type EvidenceCandidate = {
  id: string;
  kind: EvidenceCandidateKind;
  object_type: string;
  object_name: string;
  unit_name: string | null;
  source_key: string | null;
  display: string;
  path_relations: string[];
  summary: string | null;
  flags: RelevanceFlags;
  tier: EvidenceTier;
  exclude_reason: string | null;
  /** Distinct query-term stems covered by this candidate name. */
  query_term_coverage: number;
};

export type ProcessStepView = {
  text: string;
  technical_refs: string[];
  source_keys: string[];
  from_analysis: boolean;
};

export type TechnicalObjectChip = {
  object_type: string;
  object_name: string;
  unit_name: string | null;
  role: "anchor" | "participant" | "config" | "field";
};

export type ProcessAnswerView = {
  summary: string;
  technical_anchors: TechnicalObjectChip[];
  process_steps: ProcessStepView[];
  /** Methods without analysis — not shown as process steps. */
  technical_findings: TechnicalObjectChip[];
  participants: TechnicalObjectChip[];
  tables_fields_config: TechnicalObjectChip[];
  open_points: string[];
  evidence: Array<{
    source_key: string;
    label: string;
    tier: EvidenceTier;
  }>;
  relevance: {
    candidates_before: number;
    candidates_after: number;
    excluded_shared_token_only: string[];
    accepted_paths: string[];
    query_terms: string[];
    strong_seeds: string[];
  };
};

/** Object types allowed as primary process evidence without extra path proof. */
export const PROCESS_PRIMARY_OBJECT_TYPES = new Set([
  "CLASS",
  "METHOD",
  "PROGRAM",
  "FUNCTION_MODULE",
  "FUGR",
  "TABLE",
  "FIELD",
  "DDIC_FIELD",
  "INTERFACE",
  "OUTPUT_TYPE",
  "OUTPUT_PROCESSING",
]);

/** Need a real path to a strong seed — shared token alone is never enough. */
export const PROCESS_RESTRICTED_OBJECT_TYPES = new Set([
  "MESSAGE_TYPE",
  "IDOC_TYPE",
  "IDOC_SEGMENT",
  "PARTNER_PROFILE",
  "LOGICAL_SYSTEM",
  "PROCESS_CODE",
  "ALE_MODEL_ASSIGNMENT",
]);
