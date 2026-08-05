/**
 * Multi-source / staged RAG types.
 * Separate from direct_rag / planned_rag — no hybrid rebuild required.
 */
import type { EvidenceType } from "@/lib/knowledge/multiSourceSearch/evidenceScoring";

export type MultiSourceId =
  | "exact_symbol"
  | "master_data"
  | "control_tables"
  | "classes"
  | "programs"
  | "function_modules"
  | "relations";

export type AnchorKind =
  | "concept"
  | "field"
  | "value"
  | "table"
  | "object"
  | "key"
  | "symbol";

export type SearchAnchor = {
  kind: AnchorKind;
  value: string;
  /** Normalized uppercase for matching. */
  norm: string;
  source: MultiSourceId | "question" | "plan";
  confidence: number;
  note?: string;
};

export type SourceCoverage = {
  source: MultiSourceId;
  status: "ready" | "partial" | "missing" | "not_indexed";
  expected_path: string;
  exists: boolean;
  record_count_estimate: number | null;
  searchable_via: string[];
  diagnosis: string;
};

export type SearchPlanType =
  | "GENERIC"
  | "MASTER_FIELD_TO_PROCESS"
  | "CONTROL_TABLE_TO_PROCESS"
  | "TECHNICAL_SYMBOL_TO_PROCESS";

export type PrimaryAnchor = {
  anchor_type:
    | "MASTER_DATA_BUSINESS_FIELD"
    | "CONTROL_TABLE"
    | "TECHNICAL_SYMBOL";
  /** Table name, or for TECHNICAL_SYMBOL the technical token / primary object. */
  table: string;
  field?: string;
  /** Exact technical token from the question. */
  symbol?: string;
  /** Object names that contain the symbol (programs, FMs, classes). */
  objects?: string[];
  object_type?: string;
  description?: string;
  business_concept?: string;
  match_type?: string;
  /** User may have mislabeled the object type (e.g. "Nachricht"). */
  user_object_type_guess?: string;
  confidence: number;
};

export type SpecializedSearchPlan = {
  plan_type: SearchPlanType;
  primary_anchor: PrimaryAnchor | null;
  steps: string[];
  focused_stage_order?: MultiSourceId[];
  abort_broad_search: boolean;
  notes: string[];
};

export type MultiSourceSearchPlan = {
  version: "multi-source-plan-v1";
  question: string;
  concepts: string[];
  synonym_candidates: string[];
  source_order: MultiSourceId[];
  max_rounds: number;
  /** Soft budgets for evidence bundling. */
  budgets: Record<MultiSourceId, number>;
  notes: string[];
  specialized?: SpecializedSearchPlan;
};

export type StageQueryLog = {
  query: string;
  purpose: string;
  hit_count: number;
};

export type StageEvidenceItem = {
  id: string;
  source: MultiSourceId;
  rank_tier: "exact" | "value_check" | "relation" | "semantic_weak";
  evidence_type?: EvidenceType;
  title: string;
  summary: string;
  object_name?: string;
  object_type?: string;
  table_name?: string;
  field_name?: string;
  values?: Record<string, string>;
  keys?: Record<string, string>;
  tables_read?: string[];
  tables_written?: string[];
  called_functions?: string[];
  called_methods?: string[];
  evidence_lines?: string[];
  anchors_matched: string[];
  confidence: number;
  path_hint?: string;
  raw_excerpt?: string;
  primary_anchor?: PrimaryAnchor;
  score?: number;
  /** True when kept only because of a proven relation to a technical symbol object. */
  related_to_symbol?: boolean;
};

export type StageResult = {
  stage: MultiSourceId;
  round: number;
  inputs: {
    anchors: string[];
    concepts: string[];
    synonyms: string[];
  };
  queries: StageQueryLog[];
  hits: StageEvidenceItem[];
  new_anchors: SearchAnchor[];
  confidence: number;
  why_next: string;
  abort: boolean;
  abort_reason?: string;
  coverage: SourceCoverage;
  duration_ms: number;
};

export type MultiSourceEvidenceBundle = {
  items: StageEvidenceItem[];
  by_source: Record<MultiSourceId, number>;
  omitted: number;
  ranking_notes: string[];
};

export type SearchTrace = {
  template_type: SearchPlanType;
  steps: string[];
  steps_completed: string[];
  primary_anchor: PrimaryAnchor | null;
  extracted_tokens?: string[];
  exact_symbol_hits?: Array<{
    title: string;
    object_name?: string;
    object_type?: string;
    path_hint?: string;
  }>;
  discarded_semantic_hits?: Array<{
    title: string;
    source: string;
    reason: string;
  }>;
  evidence_passed_to_synthesis?: Array<{
    title: string;
    source: string;
    evidence_type?: string;
  }>;
  final_answer_preview?: string;
};

export type StructuredSearchContext = {
  question: string;
  plan_type: SearchPlanType;
  primary_anchor: PrimaryAnchor | null;
  field_values: Array<{
    table: string;
    field: string;
    value_distribution?: Record<string, string>;
    key_examples?: Record<string, string>[];
  }>;
  key_contexts: Record<string, string>[];
  control_tables: string[];
  control_values: Array<{ table: string; values: Record<string, string> }>;
  class_evidence: string[];
  program_evidence: string[];
  function_module_evidence: string[];
  relations: string[];
  coverage: Record<string, string>;
  open_questions: string[];
  primary_anchor_coverage?: {
    sufficient: boolean;
    missing: string[];
  };
};

export type MultiSourceRunMetrics = {
  duration_ms: number;
  stages_run: number;
  rounds: number;
  anchors_final: number;
  evidence_count: number;
  coverage_summary: SourceCoverage[];
  aborted_stages: string[];
  synthesis_tokens?: { input: number; output: number };
  compare_note?: string;
  plan_type?: SearchPlanType;
  primary_anchor?: PrimaryAnchor | null;
};

export type MultiSourceAnswer = {
  direct_answer: string;
  reasoning: string;
  open_questions: string[];
  sources_used: string[];
  model?: string;
};

export type MultiSourceRunResult = {
  run_id: string;
  project_key: string;
  question: string;
  plan: MultiSourceSearchPlan;
  specialized_plan: SpecializedSearchPlan;
  stages: StageResult[];
  anchors: SearchAnchor[];
  evidence: MultiSourceEvidenceBundle;
  relations: StageEvidenceItem[];
  coverage: SourceCoverage[];
  final_context: string;
  structured_context: StructuredSearchContext;
  search_trace: SearchTrace;
  answer: MultiSourceAnswer | null;
  metrics: MultiSourceRunMetrics;
  log_dir: string;
  status: "ok" | "insufficient" | "error";
  message?: string;
};
