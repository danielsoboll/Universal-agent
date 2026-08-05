import type {
  MessageIdocAreaStatus,
  MessageIdocCanonicalObjectType,
  MessageIdocConfigGroup,
  MessageIdocFileFormalStatus,
  MessageIdocRelationKind,
} from "@/lib/admin/datenbasis/messageIdocConfig/constants";

export type JsonScalarType =
  | "null"
  | "boolean"
  | "number"
  | "string"
  | "object"
  | "array"
  | "empty_string";

export type DetectedMessageIdocFile = {
  fileName: string;
  relativePath: string;
  bytes: number;
  /** Group parsed from filename suffix, if recognizable. */
  configGroupFromFileName: MessageIdocConfigGroup | null;
};

export type InvalidRowReport = {
  fileName: string;
  lineNumber: number;
  message: string;
  config_group?: string | null;
  source_table?: string | null;
};

export type FieldProfile = {
  fieldName: string;
  observedTypes: JsonScalarType[];
  nullOrEmptyCount: number;
  nonEmptyCount: number;
  nullOrEmptyRate: number;
  sampleValues: unknown[];
  distinctCountSampled: number;
  possibleKey: boolean;
};

export type DeclaredFieldInfo = {
  field_name: string;
  position: number | null;
  key: boolean | null;
  data_element: string | null;
  data_type: string | null;
  length: number | null;
  description: string | null;
  included_in_rows: boolean | null;
};

/** Schema profile for one (config_group × source_table) combination. */
export type TableSchemaProfile = {
  config_group: MessageIdocConfigGroup | string;
  source_table: string;
  fileName: string;
  relativePath: string;
  /** configuration_row counts */
  rowCount: number;
  table_definition: {
    description: string | null;
    field_count: number | null;
    client_dependent: boolean | null;
  } | null;
  declared_fields: DeclaredFieldInfo[];
  fields: FieldProfile[];
  detectedFieldNames: string[];
  possibleKeyColumns: string[];
  possibleTechnicalObjectNames: string[];
  schemaHash: string;
  profiledAt: string;
  notes: string[];
};

export type MessageIdocHeaderInfo = {
  schema_version: string | null;
  system_id: string | null;
  client: string | null;
  export_type: string | null;
  config_group: MessageIdocConfigGroup | string | null;
  tables_found: number | null;
  tables_missing: number | null;
  rows_exported: number | null;
  missing_table_names: string[];
  movement_data_included: boolean | null;
  object_selection_applied: boolean | null;
};

export type MessageIdocFileManifestEntry = {
  path: string;
  fileName: string;
  config_group: MessageIdocConfigGroup | string | null;
  system_id: string | null;
  client: string | null;
  schema_version: string | null;
  tables_found: number;
  tables_missing: number;
  missing_table_names: string[];
  rows_exported_header: number | null;
  rows_read: number;
  rows_by_source_table: Record<string, number>;
  record_type_counts: Record<string, number>;
  valid_rows: number;
  invalid_rows: number;
  empty_lines: number;
  header_count: number;
  duplicate_header: boolean;
  formal_status: MessageIdocFileFormalStatus;
  formal_status_label: string;
  source_hash: string;
  header_errors: string[];
  warnings: string[];
  schema_profile_keys: string[];
};

export type MessageIdocRawManifest = {
  pipeline_type: "MESSAGE_IDOC_CONFIG";
  project: string;
  status: MessageIdocAreaStatus;
  expected_groups: number;
  detected_groups: MessageIdocConfigGroup[];
  missing_groups: MessageIdocConfigGroup[];
  duplicate_groups: MessageIdocConfigGroup[];
  files: MessageIdocFileManifestEntry[];
  schema_hash: string;
  source_hash: string;
  created_at: string;
  updated_at: string;
  invalid_row_samples: InvalidRowReport[];
  schema_profile_paths: Record<string, string>;
  planned_canonical_object_types: readonly MessageIdocCanonicalObjectType[];
  planned_relation_kinds: readonly MessageIdocRelationKind[];
  excluded_movement_data: readonly string[];
  expected_source_tables: Record<string, readonly string[]>;
  notes: string[];
};

export type MessageIdocStatusSnapshot = {
  pipeline_type: "MESSAGE_IDOC_CONFIG";
  project: string;
  status: MessageIdocAreaStatus;
  status_label: string;
  expected_groups: number;
  detected_groups: number;
  missing_groups: string[];
  duplicate_groups: string[];
  file_count: number;
  valid_rows_total: number;
  invalid_rows_total: number;
  profiles_written: number;
  manifest_path: string | null;
  updated_at: string;
  converted: boolean;
  indexed: boolean;
};

export type MessageIdocCanonicalObjectSkeleton = {
  object_type: MessageIdocCanonicalObjectType;
  object_id: string | null;
  display_name: string | null;
  source: {
    raw_file: string | null;
    config_group: string | null;
    source_table: string | null;
    raw_row_hint: string | null;
  };
  attributes: Record<string, unknown>;
};

export type MessageIdocConfigurationRelationSkeleton = {
  relation_kind: MessageIdocRelationKind;
  from_object_type: MessageIdocCanonicalObjectType | null;
  from_object_id: string | null;
  to_object_type: MessageIdocCanonicalObjectType | null;
  to_object_id: string | null;
  attributes: Record<string, unknown>;
};
