/**
 * Nachrichten- und IDoc-Konfiguration — Konstanten.
 *
 * 10 fachliche Exportgruppen aus dem SAP-Report (dynamischer Dateipräfix).
 * Keine Z-/Y-Dateifilterung. Keine Bewegungsdaten. Kein endgültiges Canonical-Mapping.
 */

export const PIPELINE_TYPE = "MESSAGE_IDOC_CONFIG" as const;
export const EXPECTED_EXPORT_TYPE = "MESSAGE_IDOC_CONFIG" as const;

export const RAW_FOLDER_PARTS = ["message-idoc-config"] as const;
export const RAW_FOLDER = "raw/message-idoc-config";
export const CANONICAL_FOLDER = "canonical/message-idoc-config";
export const LOG_FOLDER = "logs/message-idoc-config";

export const MANIFEST_REL = "message-idoc-config/raw-manifest.json";
export const STATUS_REL = "message-idoc-config/status.json";
export const SCHEMA_PROFILES_DIR = "message-idoc-config/schema-profiles";

/** Die 10 stabilen config_group-Namen (Dateiname-Suffix + Header). */
export const CONFIG_GROUPS = [
  "MESSAGE_IDOC_01_OUTPUT_TYPES",
  "MESSAGE_IDOC_02_OUTPUT_PROCESSING",
  "MESSAGE_IDOC_03_ALE_MESSAGE_TYPES",
  "MESSAGE_IDOC_04_TYPE_ASSIGNMENTS",
  "MESSAGE_IDOC_05_IDOC_TYPES_EXTENSIONS",
  "MESSAGE_IDOC_06_IDOC_SEGMENTS",
  "MESSAGE_IDOC_07_PARTNER_PROFILES",
  "MESSAGE_IDOC_08_PROCESS_CODES",
  "MESSAGE_IDOC_09_PORTS",
  "MESSAGE_IDOC_10_ALE_ROUTING",
] as const;

export type MessageIdocConfigGroup = (typeof CONFIG_GROUPS)[number];

export const EXPECTED_GROUPS = CONFIG_GROUPS.length;

/**
 * Erwartete Quelltabellen je Gruppe (Dokumentation / Vollständigkeits-Hinweis).
 * Fehlende Tabellen im System sind kein Validierungsfehler.
 */
export const EXPECTED_SOURCE_TABLES: Record<
  MessageIdocConfigGroup,
  readonly string[]
> = {
  MESSAGE_IDOC_01_OUTPUT_TYPES: ["T685", "T685T"],
  MESSAGE_IDOC_02_OUTPUT_PROCESSING: ["TNAPR"],
  MESSAGE_IDOC_03_ALE_MESSAGE_TYPES: ["EDMSG", "EDMSGT", "EDIMSGT"],
  MESSAGE_IDOC_04_TYPE_ASSIGNMENTS: ["EDIMSG", "TBD57"],
  MESSAGE_IDOC_05_IDOC_TYPES_EXTENSIONS: ["EDIDO", "EDIDOT"],
  MESSAGE_IDOC_06_IDOC_SEGMENTS: [
    "EDISDEF",
    "EDISEG",
    "EDISEGT",
    "EDISYN",
    "EDISYNT",
  ],
  MESSAGE_IDOC_07_PARTNER_PROFILES: ["EDPP1", "EDP12", "EDP13", "EDP21"],
  MESSAGE_IDOC_08_PROCESS_CODES: [
    "TEDE1",
    "TEDE2",
    "TEDE3",
    "TEDE4",
    "TBD52",
    "TBD57",
  ],
  MESSAGE_IDOC_09_PORTS: [
    "EDIPORT",
    "EDIPOA",
    "EDIPOD",
    "EDIPOF",
    "EDIPOM",
    "EDIPOP",
    "EDIPOS",
    "EDIPOT",
  ],
  MESSAGE_IDOC_10_ALE_ROUTING: [
    "TBDLS",
    "TBDLST",
    "TBDME",
    "TBDM",
    "TBD62",
    "TBD64",
  ],
};

/**
 * Geplante Canonical-Objekttypen (Transportgruppen ≠ Canonical-Objekte).
 * Noch nicht an RAW-Feldnamen gekoppelt.
 */
export const CANONICAL_OBJECT_TYPES = [
  "output_type",
  "output_type_text",
  "output_processing",
  "ale_message_type",
  "ale_message_type_text",
  "message_type_idoc_assignment",
  "idoc_type",
  "idoc_type_text",
  "idoc_extension",
  "idoc_segment",
  "idoc_segment_text",
  "partner_profile",
  "process_code",
  "process_code_function",
  "port",
  "logical_system",
  "ale_model_assignment",
  "configuration_relation",
] as const;

export type MessageIdocCanonicalObjectType =
  (typeof CANONICAL_OBJECT_TYPES)[number];

export const CONFIGURATION_RELATION_KINDS = [
  "OUTPUT_TYPE_TO_PROGRAM",
  "OUTPUT_TYPE_TO_ROUTINE",
  "OUTPUT_TYPE_TO_PARTNER_FUNCTION",
  "MESSAGE_TYPE_TO_IDOC_TYPE",
  "IDOC_TYPE_TO_EXTENSION",
  "IDOC_TYPE_TO_SEGMENT",
  "PARTNER_TO_MESSAGE_TYPE",
  "PARTNER_TO_IDOC_TYPE",
  "PARTNER_TO_PORT",
  "PROCESS_CODE_TO_FUNCTION",
  "TECHNICAL_OBJECT_TO_PROGRAM",
  "TECHNICAL_OBJECT_TO_FUNCTION_MODULE",
  "LOGICAL_SYSTEM_TO_MESSAGE_TYPE",
  "ALE_MODEL_TO_RECEIVER",
] as const;

export type MessageIdocRelationKind =
  (typeof CONFIGURATION_RELATION_KINDS)[number];

/** Explizit ausgeschlossene Bewegungs-/Laufzeitdaten. */
export const EXCLUDED_MOVEMENT_TABLES = [
  "EDIDC",
  "EDID4",
  "EDIDS",
] as const;

export const EXCLUDED_MOVEMENT_HINTS = [
  ...EXCLUDED_MOVEMENT_TABLES,
  "RUNTIME_IDOC",
  "IDOC_RUNTIME",
  "IDOC_NUMBER",
  "NUTZDATEN",
  "STATUSHISTORIE",
  "ANWENDUNGSBELEG",
] as const;

export const AREA_STATUS_VALUES = [
  "keine_dateien",
  "unvollstaendig",
  "alle_gruppen_erkannt",
  "validiert",
  "schema_profiliert",
  "bereit_fuer_mapping",
  "konvertiert",
  "indexiert",
] as const;

export type MessageIdocAreaStatus = (typeof AREA_STATUS_VALUES)[number];

export const AREA_STATUS_LABELS: Record<MessageIdocAreaStatus, string> = {
  keine_dateien: "keine Dateien",
  unvollstaendig: "unvollständig",
  alle_gruppen_erkannt: "alle 10 Gruppen erkannt",
  validiert: "validiert",
  schema_profiliert: "Schema profiliert",
  bereit_fuer_mapping: "bereit für Canonical Mapping",
  konvertiert: "konvertiert",
  indexiert: "indexiert",
};

/** Per-file / per-group formal status (not overall area status). */
export type MessageIdocFileFormalStatus =
  | "ok"
  | "keine_unterstuetzten_quelltabellen"
  | "header_invalid"
  | "empty"
  | "validation_errors";

export function isConfigGroup(value: string): value is MessageIdocConfigGroup {
  return (CONFIG_GROUPS as readonly string[]).includes(value);
}
