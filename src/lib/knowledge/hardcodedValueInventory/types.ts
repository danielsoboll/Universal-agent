/**
 * HARDCODED_VALUE_INVENTORY — types.
 */

export type HardcodedValueIntent =
  | "HARDCODED_VALUE_INVENTORY"
  | "NOT_HARDCODED_VALUE";

export type HardcodedValueType =
  | "MATERIAL_NUMBER"
  | "CUSTOMER_NUMBER"
  | "VENDOR_NUMBER"
  | "PLANT"
  | "GENERIC"
  | "UNKNOWN";

export type HardcodedValueContext =
  | "BUSINESS_PROCESS"
  | "LOCATIONS"
  | "NONE";

export type HardcodedValueQueryClassification = {
  intent: HardcodedValueIntent;
  requested_value_type: HardcodedValueType;
  requested_context: HardcodedValueContext;
  matched_cues: string[];
};

export type HardcodedOccurrence = {
  material_number: string;
  /** Digits-only / normalized internal form when applicable. */
  material_number_internal: string;
  original_literal: string;
  source_key: string;
  object_type: string;
  object_name: string;
  unit_name: string;
  unit_type: string;
  line_number: number | null;
  snippet: string;
  condition: string | null;
  action: string | null;
  tables_fields: string[];
  active_code: boolean;
  comment_only: boolean;
  confidence: number;
  claim_status: "AUTHORITATIVE" | "CODE_DERIVED" | "INFERRED";
  process_label: string | null;
  process_rationale: string | null;
};

export type HardcodedMaterialCard = {
  material_number: string;
  material_number_internal: string;
  occurrence_count: number;
  process_label: string | null;
  condition_summary: string | null;
  effect_summary: string | null;
  evidence_status: string;
  claim_status: "AUTHORITATIVE" | "CODE_DERIVED" | "INFERRED";
  occurrences: HardcodedOccurrence[];
};

export type HardcodedValueAnswerView = {
  summary: {
    text: string;
    unique_material_count: number;
    active_occurrence_count: number;
    comment_only_count: number;
    excluded_literal_count: number;
    units_scanned: number;
    units_with_matnr_context: number;
  };
  materials: HardcodedMaterialCard[];
  multi_use: HardcodedMaterialCard[];
  comment_or_unclear: HardcodedMaterialCard[];
  excluded_sample: Array<{ literal: string; reason: string }>;
  missing_information: string[];
  sources: string[];
};

export type HardcodedValueDiagnostics = {
  classification: HardcodedValueQueryClassification;
  units_scanned: number;
  units_with_matnr_context: number;
  literals_seen: number;
  accepted_candidates: number;
  excluded_candidates: number;
  unique_materials: string[];
  duration_ms: number;
  enrichment?: {
    attempted: boolean;
    succeeded: boolean;
    batches: number;
    enriched_count: number;
    duration_ms: number;
    error: string | null;
    mara_hits?: number;
    analysis_hit_units?: number;
    validated_accepted?: number;
    validated_rejected?: number;
  };
};

export type HardcodedValueInventoryResult = {
  used: boolean;
  classification: HardcodedValueQueryClassification;
  answer_view: HardcodedValueAnswerView | null;
  summary_sentence: string;
  diagnostics: HardcodedValueDiagnostics;
  sources: string[];
  duration_ms: number;
};
