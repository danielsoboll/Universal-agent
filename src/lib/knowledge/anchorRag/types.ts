/**
 * Unified anchor-based SAP RAG schema.
 * Generic — no per-customer or per-symbol special cases.
 */

export const EVIDENCE_GRAPH_SCHEMA_VERSION = "anchor-rag-v1";

/** Canonical node types for the evidence graph. */
export const GRAPH_NODE_TYPES = [
  "CLASS",
  "METHOD",
  "PROGRAM",
  "INCLUDE",
  "FORM_ROUTINE",
  "FUNCTION_MODULE",
  "FUNCTION_GROUP",
  "TABLE",
  "FIELD",
  "CONTROL_TABLE",
  "CONTROL_TABLE_ROW",
  "MASTER_DATA_ENTITY",
  "MASTER_DATA_FIELD",
  "MASTER_DATA_VALUE",
  "OUTPUT_TYPE",
  "OUTPUT_TYPE_TEXT",
  "OUTPUT_PROCESSING",
  "MESSAGE_TYPE",
  "IDOC_TYPE",
  "IDOC_EXTENSION",
  "IDOC_SEGMENT",
  "PARTNER_PROFILE",
  "PROCESS_CODE",
  "PORT",
  "LOGICAL_SYSTEM",
  "TECHNICAL_SYMBOL",
  "UNKNOWN",
] as const;

export type GraphNodeType = (typeof GRAPH_NODE_TYPES)[number];

/** Unified relation kinds (target model). */
export const GRAPH_RELATION_KINDS = [
  "CLASS_CONTAINS_METHOD",
  "PROGRAM_CONTAINS_INCLUDE",
  "PROGRAM_CONTAINS_FORM_ROUTINE",
  "CODE_CALLS_METHOD",
  "CODE_CALLS_FUNCTION_MODULE",
  "CODE_PERFORMS_FORM_ROUTINE",
  "CODE_SUBMITS_PROGRAM",
  "CODE_READS_TABLE",
  "CODE_WRITES_TABLE",
  "CODE_USES_FIELD",
  "CODE_CHECKS_VALUE",
  "FUNCTION_MODULE_BELONGS_TO_FUNCTION_GROUP",
  "OUTPUT_TYPE_HAS_TEXT",
  "OUTPUT_TYPE_USES_MEDIUM",
  "OUTPUT_TYPE_PROCESSED_BY_PROGRAM",
  "OUTPUT_TYPE_USES_ROUTINE",
  "OUTPUT_TYPE_MAPS_TO_MESSAGE_TYPE",
  "MESSAGE_TYPE_MAPS_TO_IDOC_TYPE",
  "IDOC_TYPE_HAS_EXTENSION",
  "IDOC_TYPE_CONTAINS_SEGMENT",
  "PARTNER_PROFILE_USES_MESSAGE_TYPE",
  "PARTNER_PROFILE_USES_IDOC_TYPE",
  "PARTNER_PROFILE_USES_PORT",
  "PROCESS_CODE_CALLS_FUNCTION_MODULE",
  "CONTROL_TABLE_HAS_ROW",
  "CODE_READS_CONTROL_TABLE",
  "CONTROL_ROW_REFERENCES_CUSTOMER",
  "CONTROL_ROW_REFERENCES_VENDOR",
  "PARTNER_NUMBER_MATCHES_CUSTOMER",
  "PARTNER_NUMBER_MATCHES_VENDOR",
  "MASTER_ENTITY_HAS_FIELD_VALUE",
  "TECHNICAL_OBJECT_TO_PROGRAM",
  "TECHNICAL_OBJECT_TO_FUNCTION_MODULE",
  "RELATED",
] as const;

export type GraphRelationKind = (typeof GRAPH_RELATION_KINDS)[number];

export type RelationResolution =
  | "RESOLVED_STATIC"
  | "RESOLVED_BY_TYPE"
  | "DYNAMIC_WITH_VALUE"
  | "DYNAMIC_UNRESOLVED"
  | "SOURCE_SCOPE_UNKNOWN"
  | "INFERRED";

export type EvidenceGraphNode = {
  id: string;
  type: GraphNodeType;
  name: string;
  source: string;
  source_path: string;
  exact_match: boolean;
  score: number;
  attributes: Record<string, unknown>;
};

export type EvidenceGraphEdge = {
  from: string;
  relation: GraphRelationKind;
  to: string;
  resolution: RelationResolution;
  evidence: string[];
  confidence: number;
  hop?: number;
};

export type EvidenceGraph = {
  schema_version: string;
  question: string;
  primary_anchors: string[];
  nodes: EvidenceGraphNode[];
  edges: EvidenceGraphEdge[];
  generated_at: string;
};

/** Inventory bucket types for Global Anchor Sweep. */
export const ANCHOR_HIT_TYPES = [
  "PROGRAM",
  "INCLUDE",
  "FORM_ROUTINE",
  "FUNCTION_MODULE",
  "METHOD",
  "CLASS",
  "CONTROL_TABLE",
  "CONTROL_TABLE_ROW",
  "OUTPUT_TYPE",
  "OUTPUT_TYPE_TEXT",
  "OUTPUT_PROCESSING",
  "MESSAGE_TYPE",
  "IDOC_TYPE",
  "PARTNER_PROFILE",
  "MASTER_DATA_FIELD",
  "MASTER_DATA_VALUE",
  "PROCESS_CODE",
  "PORT",
  "OTHER",
] as const;

export type AnchorHitType = (typeof ANCHOR_HIT_TYPES)[number];

export type AnchorHit = {
  type: AnchorHitType;
  name: string;
  object_id?: string;
  source_path: string;
  exact_match: boolean;
  score: number;
  summary?: string;
  attributes?: Record<string, unknown>;
};

export type AnchorInventory = {
  anchor: string;
  hits_by_type: Record<AnchorHitType, number>;
  hits: AnchorHit[];
};

export type EvidencePackage = {
  question: string;
  primary_anchors: string[];
  configuration: Record<string, unknown>;
  code_units: Array<Record<string, unknown>>;
  call_chains: Array<Record<string, unknown>>;
  table_accesses: Array<Record<string, unknown>>;
  control_rows: Array<Record<string, unknown>>;
  master_data_contexts: Array<Record<string, unknown>>;
  idoc_configuration: Record<string, unknown>;
  partners: Array<Record<string, unknown>>;
  customers: Array<Record<string, unknown>>;
  proven_claims: string[];
  inferred_claims: string[];
  conflicts: string[];
  open_questions: string[];
  source_coverage: Record<string, string | number>;
};

export type DeepSearchPlanRound = {
  answerable_now: boolean;
  known_facts: string[];
  missing_information: string[];
  hypotheses_to_verify: string[];
  next_anchor_queries: Array<{
    anchor: string;
    target_types: string[];
    relations_to_follow: string[];
    reason: string;
  }>;
};
