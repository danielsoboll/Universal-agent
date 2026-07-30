import { createHash } from "crypto";

export const CONTROL_TABLE_SCHEMA_VERSION = "1.0";

export type ControlTableField = {
  field_name: string;
  position: number;
  key: boolean;
  data_element: string;
  domain: string;
  data_type: string;
  length: number;
  decimals: number;
  description: string;
};

export type CanonicalTableDefinition = {
  record_type: "table_definition";
  schema_version: string;
  source_key: string;
  system_id: string;
  client: string;
  table_name: string;
  description: string;
  package: string;
  delivery_class: string;
  table_category: string;
  active: boolean;
  client_dependent: boolean;
  maintenance_allowed: boolean;
  maintenance_dialog_exists: boolean;
  maintenance_views: string[];
  row_count: number;
  key_fields: string[];
  fields: ControlTableField[];
  content_hash: string;
  source_file: string;
};

export type CanonicalTableClassification = {
  record_type: "table_classification";
  schema_version: string;
  source_key: string;
  system_id: string;
  client: string;
  table_name: string;
  classification: string;
  score: number;
  reasons: string[];
  content_export_allowed: boolean;
  row_count: number;
  classification_version: string;
  content_hash: string;
  source_file: string;
};

export type CanonicalTableRow = {
  record_type: "table_row";
  schema_version: string;
  source_key: string;
  system_id: string;
  client: string;
  table_name: string;
  primary_key: Record<string, string>;
  values: Record<string, string>;
  normalized_values: Record<string, string>;
  row_hash: string;
  classification: string;
  classification_score: number;
  content_hash: string;
  source_file: string;
};

export type TableEntity = {
  record_type: "table_entity";
  schema_version: string;
  source_key: string;
  entity_id: string;
  entity_type: string;
  value: string;
  normalized_value: string;
  confidence: number;
  table_name: string;
  field_name: string;
  row_source_key: string;
  evidence: {
    data_element?: string;
    domain?: string;
    data_type?: string;
    field_description?: string;
  };
  content_hash: string;
};

export type TableRelation = {
  record_type: "table_relation";
  schema_version: string;
  source_key: string;
  relation_type: string;
  from_type: string;
  from_key: string;
  to_type: string;
  to_key: string;
  metadata?: Record<string, unknown>;
  content_hash: string;
};

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(",")}}`;
}

export function normalizeCellValue(value: unknown): string {
  if (value == null) return "";
  return String(value).replace(/\s+/g, " ").trim();
}

/**
 * Serialize primary key in DDIC key-field order: FIELD=value|FIELD=value
 * Independent of JSON object key order.
 */
export function serializeCanonicalPrimaryKey(
  keyFields: string[],
  primaryKey: Record<string, unknown>,
): string {
  const parts: string[] = [];
  for (const field of keyFields) {
    const raw = primaryKey[field];
    const value = normalizeCellValue(raw);
    parts.push(`${field}=${value}`);
  }
  // Include any extra pk fields not in DDIC list (stable sorted) for robustness
  const known = new Set(keyFields.map((f) => f.toUpperCase()));
  const extras = Object.keys(primaryKey)
    .filter((k) => !known.has(k.toUpperCase()))
    .sort((a, b) => a.localeCompare(b));
  for (const field of extras) {
    parts.push(`${field}=${normalizeCellValue(primaryKey[field])}`);
  }
  return parts.join("|");
}

export function buildTableDefinitionSourceKey(
  systemId: string,
  client: string,
  tableName: string,
): string {
  return [systemId, client, tableName].join("|");
}

export function buildTableRowSourceKey(
  systemId: string,
  client: string,
  tableName: string,
  canonicalPrimaryKey: string,
): string {
  return [systemId, client, tableName, canonicalPrimaryKey].join("|");
}

export function recordsToJsonl(records: Record<string, unknown>[]): string {
  if (records.length === 0) return "";
  return `${records.map((r) => JSON.stringify(r)).join("\n")}\n`;
}
