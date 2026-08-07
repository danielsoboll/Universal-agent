/**
 * Map legacy relation_type / relation_kind strings → unified GraphRelationKind.
 * Deterministic, corpus-agnostic — no symbol-specific rules.
 */
import type { GraphNodeType, GraphRelationKind } from "./types";

const LEGACY_TO_UNIFIED: Record<string, GraphRelationKind> = {
  // programs / FMs
  INCLUDES: "PROGRAM_CONTAINS_INCLUDE",
  DEFINES_FORM: "PROGRAM_CONTAINS_FORM_ROUTINE",
  PERFORMS: "CODE_PERFORMS_FORM_ROUTINE",
  PERFORMS_FORM: "CODE_PERFORMS_FORM_ROUTINE",
  CALLS_FUNCTION: "CODE_CALLS_FUNCTION_MODULE",
  CALLS_FUNCTION_MODULE: "CODE_CALLS_FUNCTION_MODULE",
  CALLS_METHOD: "CODE_CALLS_METHOD",
  CALLS_STATIC_METHOD_SYMBOL: "CODE_CALLS_METHOD",
  CALLS_TRANSACTION: "RELATED",
  SUBMITS_PROGRAM: "CODE_SUBMITS_PROGRAM",
  READS_TABLE: "CODE_READS_TABLE",
  WRITES_TABLE: "CODE_WRITES_TABLE",
  UNRESOLVED_INSTANCE_METHOD_CALL: "RELATED",
  UNRESOLVED_DYNAMIC_CALL: "RELATED",
  UNRESOLVED_DYNAMIC_TABLE_ACCESS: "RELATED",
  BELONGS_TO: "FUNCTION_MODULE_BELONGS_TO_FUNCTION_GROUP",
  IMPLEMENTED_IN_INCLUDE: "PROGRAM_CONTAINS_INCLUDE",
  SUBMIT: "CODE_SUBMITS_PROGRAM",
  SUBMITS: "CODE_SUBMITS_PROGRAM",
  // classes
  CONTAINS: "CLASS_CONTAINS_METHOD",
  CALLS_MACRO: "RELATED",
  // message-idoc
  OUTPUT_TYPE_HAS_TEXT: "OUTPUT_TYPE_HAS_TEXT",
  MESSAGE_TYPE_HAS_TEXT: "RELATED",
  IDOC_TYPE_HAS_TEXT: "RELATED",
  OUTPUT_TYPE_TO_PROGRAM: "OUTPUT_TYPE_PROCESSED_BY_PROGRAM",
  OUTPUT_TYPE_TO_ROUTINE: "OUTPUT_TYPE_USES_ROUTINE",
  OUTPUT_TYPE_TO_PARTNER_FUNCTION: "RELATED",
  PROCESSED_BY_PROGRAM: "OUTPUT_TYPE_PROCESSED_BY_PROGRAM",
  PROCESSED_BY_ROUTINE: "OUTPUT_TYPE_USES_ROUTINE",
  USES_FORM: "RELATED",
  USES_IDOC_TYPE: "MESSAGE_TYPE_MAPS_TO_IDOC_TYPE",
  USES_IDOC_EXTENSION: "IDOC_TYPE_HAS_EXTENSION",
  USES_IDOC_TYPE_IN_PROFILE: "MESSAGE_TYPE_MAPS_TO_IDOC_TYPE",
  USES_IDOC_EXTENSION_IN_PROFILE: "IDOC_TYPE_HAS_EXTENSION",
  CONFIGURES_MESSAGE_TYPE: "PARTNER_PROFILE_USES_MESSAGE_TYPE",
  MESSAGE_TYPE_TO_IDOC_TYPE: "MESSAGE_TYPE_MAPS_TO_IDOC_TYPE",
  IDOC_TYPE_TO_EXTENSION: "IDOC_TYPE_HAS_EXTENSION",
  IDOC_TYPE_TO_SEGMENT: "IDOC_TYPE_CONTAINS_SEGMENT",
  PARTNER_TO_MESSAGE_TYPE: "PARTNER_PROFILE_USES_MESSAGE_TYPE",
  PARTNER_TO_IDOC_TYPE: "PARTNER_PROFILE_USES_IDOC_TYPE",
  PARTNER_TO_PORT: "PARTNER_PROFILE_USES_PORT",
  PROCESS_CODE_TO_FUNCTION: "PROCESS_CODE_CALLS_FUNCTION_MODULE",
  TECHNICAL_OBJECT_TO_PROGRAM: "TECHNICAL_OBJECT_TO_PROGRAM",
  TECHNICAL_OBJECT_TO_FUNCTION_MODULE: "TECHNICAL_OBJECT_TO_FUNCTION_MODULE",
  LOGICAL_SYSTEM_TO_MESSAGE_TYPE: "RELATED",
  ALE_MODEL_TO_RECEIVER: "RELATED",
  // control tables
  TABLE_CONTAINS_ROW: "CONTROL_TABLE_HAS_ROW",
  ROW_REFERENCES_ENTITY: "RELATED",
  ROW_HAS_KEY: "RELATED",
  ROW_HAS_VALUE: "RELATED",
  TABLE_HAS_FIELD: "RELATED",
  // code↔table links
  READS_TABLE_FIELD: "CODE_USES_FIELD",
  RESOLVES_TABLE_ROW: "CODE_READS_CONTROL_TABLE",
  RESOLVES_TABLE_ROW_CANDIDATE: "CODE_READS_CONTROL_TABLE",
  CODE_CHECKS_VALUE: "CODE_CHECKS_VALUE",
  CLASS_CONTAINS_METHOD: "CLASS_CONTAINS_METHOD",
};

/** Message-idoc object_type → graph node type. */
const MSGIDOC_OBJECT_TO_NODE: Record<string, GraphNodeType> = {
  output_type: "OUTPUT_TYPE",
  output_type_text: "OUTPUT_TYPE_TEXT",
  output_processing: "OUTPUT_PROCESSING",
  ale_message_type: "MESSAGE_TYPE",
  ale_message_type_text: "MESSAGE_TYPE",
  message_type_idoc_assignment: "MESSAGE_TYPE",
  idoc_type: "IDOC_TYPE",
  idoc_type_text: "IDOC_TYPE",
  idoc_extension: "IDOC_EXTENSION",
  idoc_segment: "IDOC_SEGMENT",
  idoc_segment_text: "IDOC_SEGMENT",
  partner_profile: "PARTNER_PROFILE",
  process_code: "PROCESS_CODE",
  process_code_function: "PROCESS_CODE",
  port: "PORT",
  logical_system: "LOGICAL_SYSTEM",
  ale_model_assignment: "UNKNOWN",
};

export function mapLegacyRelation(
  raw: string | null | undefined,
): GraphRelationKind {
  if (!raw) return "RELATED";
  const key = raw.trim().toUpperCase().replace(/\s+/g, "_");
  return LEGACY_TO_UNIFIED[key] ?? LEGACY_TO_UNIFIED[raw] ?? "RELATED";
}

export function mapMessageIdocObjectType(
  objectType: string | null | undefined,
): GraphNodeType {
  if (!objectType) return "UNKNOWN";
  return MSGIDOC_OBJECT_TO_NODE[objectType] ?? "UNKNOWN";
}

export function mapCodeUnitObjectType(
  objectType: string | null | undefined,
  unitType?: string | null,
): GraphNodeType {
  const o = (objectType ?? "").toUpperCase();
  const u = (unitType ?? "").toUpperCase();
  if (o === "CLASS" || u === "CLASS") return "CLASS";
  if (u === "METHOD" || o === "METHOD") return "METHOD";
  if (o === "FUNCTION_MODULE" || u === "FUNCTION") return "FUNCTION_MODULE";
  if (u === "FORM" || u === "FORM_ROUTINE") return "FORM_ROUTINE";
  if (u === "INCLUDE" || o === "INCLUDE") return "INCLUDE";
  if (o === "PROGRAM" || u === "PROGRAM" || u === "FULL_PROGRAM") return "PROGRAM";
  if (o === "FUNCTION_GROUP") return "FUNCTION_GROUP";
  return "UNKNOWN";
}

/**
 * Infer CONTROL_ROW_REFERENCES_* from entity type strings in CT relations.
 */
export function mapEntityReferenceRelation(
  entityType: string | null | undefined,
): GraphRelationKind | null {
  const t = (entityType ?? "").toLowerCase();
  if (t.includes("customer")) return "CONTROL_ROW_REFERENCES_CUSTOMER";
  if (t.includes("vendor")) return "CONTROL_ROW_REFERENCES_VENDOR";
  return null;
}
