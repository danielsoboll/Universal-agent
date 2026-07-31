import { createHash } from "crypto";

export const TABLE_KNOWLEDGE_VERSION = "table-knowledge-v1";

export type TableCategory =
  | "control_table"
  | "customizing_like"
  | "mapping_table"
  | "parameter_table"
  | "status_table"
  | "configuration_table"
  | "transaction_data"
  | "master_data_like"
  | "technical_table"
  | "unknown";

export type TableFieldMeta = {
  field_name: string;
  key: boolean;
  data_element: string;
  data_type: string;
  length: number;
  description: string;
};

export type TableKnowledgeUnit = {
  knowledge_unit_id: string;
  customer_id: string;
  system_id: string;
  table_name: string;
  table_description: string;
  table_category: string;
  classification: string;
  classification_confidence: number;
  category: TableCategory;
  fields: TableFieldMeta[];
  key_fields: string[];
  row_count: number;
  distinct_key_count: number;
  duplicate_count: number;
  collision_count: number;
  referenced_by_code: boolean;
  code_references: string[];
  business_terms: string[];
  facts: string[];
  inferences: string[];
  evidence_refs: string[];
  content_hash: string;
  package: string;
  delivery_class: string;
};

export type TableRuleGroup = {
  rule_group_id: string;
  table_name: string;
  group_key: string;
  title: string;
  row_count: number;
  key_range_or_values: string[];
  controlling_fields: string[];
  controlled_values: string[];
  facts: string[];
  cautious_inferences: string[];
  code_references: string[];
  row_evidence_refs: string[];
  confidence: number;
  content_hash: string;
  grouping_strategy: string;
};

export type TableRowEvidence = {
  row_id: string;
  table_name: string;
  normalized_key: string;
  field_values: Record<string, string>;
  source_ref: string;
  content_hash: string;
  primary_search_document: boolean;
  primary_reason: string | null;
};

export type CodeTableBinding = {
  binding_id: string;
  code_source_key: string;
  program_or_class: string;
  unit_name: string;
  table_name: string;
  access_kind: string;
  access_mode: "static" | "dynamic";
  fields: string[];
  key_filters: string[];
  resolved_row_ids: string[];
  resolved_rule_group_ids: string[];
  evidence_from_code: string[];
  evidence_from_table: string[];
  confidence: number;
  content_hash: string;
};

export function sha256Stable(parts: string[]): string {
  return createHash("sha256").update(parts.join("\n"), "utf8").digest("hex");
}

export function shortId(hash: string, n = 16): string {
  return hash.slice(0, n);
}
