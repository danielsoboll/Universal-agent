/**
 * Neutral KnowledgeRecord / IndexRecord contract.
 *
 * Layer position (do not confuse):
 *   RAW → Source Normalization → Canonical Knowledge
 *     → Cross-Source Linking / Knowledge Graph
 *     → ACCESS INDICES  ← this package consumes KnowledgeRecords
 *     → Embeddings (optional)
 *     → Ask
 *
 * Access indices must NEVER:
 * - replace canonical or raw
 * - invent fachliche Wahrheit
 * - drop evidence back-references
 * - lock today's canonical file layout as the forever model
 *
 * Adapters map source-specific shapes → KnowledgeRecord.
 * Index builders map KnowledgeRecord → specialized access indexes.
 */

export const KNOWLEDGE_RECORD_VERSION = "knowledge-record-v1";

export type KnowledgeRecordType =
  | "OBJECT"
  | "ATTRIBUTE"
  | "RELATION"
  | "CODE_UNIT"
  | "CODE_REFERENCE"
  | "LITERAL"
  | "TEXT"
  | "ANALYSIS"
  | "CONFIG"
  | "MASTER_DATA"
  | "EVIDENCE";

/**
 * Stable intermediate record — source-agnostic.
 * Not every field is set on every record.
 */
export type KnowledgeRecord = {
  /** Stable id within project+system (prefer content-addressable or source_key-derived). */
  id: string;
  project_id: string;
  system_id: string;

  entity_type?: string;
  entity_id?: string;
  entity_name?: string;

  record_type: KnowledgeRecordType;

  source_type: string;
  source_key: string;
  /** Always relative to project root (P01/...), never absolute Mac paths. */
  relative_source_path: string;
  content_hash: string;

  parent_id?: string;
  object_type?: string;
  object_name?: string;
  subobject_name?: string;
  field_name?: string;
  relation_type?: string;
  target_id?: string;
  target_name?: string;
  literal_value?: string;
  normalized_literal?: string;
  technical_context?: string[];
  text?: string;
  /** Compact preview only — full proof lives in Evidence / original path. */
  statement_preview?: string;
  line_start?: number | null;
  line_end?: number | null;
  metadata?: Record<string, unknown>;
};

/** What an access-index builder accepts (same shape; naming clarity). */
export type IndexRecord = KnowledgeRecord;

export type AccessIndexKind =
  | "symbol"
  | "literal"
  | "field_usage"
  | "lexical"
  | "graph"
  | "evidence"
  | "vector";

/**
 * Adapter boundary: one source family → stream of KnowledgeRecords.
 * No shared "one parser fits all" — each source keeps its own adapter.
 */
export type KnowledgeSourceAdapter = {
  /** Stable adapter id, e.g. sap_code_units, sap_search_documents, sap_kg_edges */
  id: string;
  source_family:
    | "master_data"
    | "control_tables"
    | "message_idoc"
    | "repository_objects"
    | "repository_relations"
    | "abap_code"
    | "method_analysis"
    | "knowledge_graph"
    | "search_documents"
    | "other";
  description: string;
  /** Relative source paths this adapter reads (for manifests / incremental). */
  listSourcePaths: (ctx: {
    projectId: string;
    systemId: string;
    dataRoot: string;
  }) => string[];
};

/**
 * Pipeline stages — documentation + runtime guards.
 * Access index build must only claim stage "access_indices".
 */
export const DATA_PIPELINE_STAGES = [
  "raw",
  "source_normalization",
  "canonical_knowledge",
  "cross_source_linking",
  "access_indices",
  "embeddings",
  "ask",
] as const;

export type DataPipelineStage = (typeof DATA_PIPELINE_STAGES)[number];

export const ACCESS_INDEX_STAGE: DataPipelineStage = "access_indices";
