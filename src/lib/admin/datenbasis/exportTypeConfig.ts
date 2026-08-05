/**
 * Central export-type configuration for Datenbasis (Stage 3).
 *
 * Rules:
 * - Fill only evidence-backed fields.
 * - certainty: verified | inferred_from_raw | unknown
 * - Never invent filename patterns (MARA/STRUCTURE/CONTENT/MAX/LIMITED etc.).
 * - Extensible: add types / fill unknown fields later without rebuilding UI/pipeline.
 *
 * Evidence (Phase 1):
 * - Classes RAW aktiv: P01/raw/classes/D01_20260804_025228_SAP_CLASSES_CONTENT.jsonl
 *   (SAP_CLASSES, schema 2.8, object_count 965); _quarantine ignoriert
 * - Materials RAW (P01, 2026-08-04): 10 JSONL unter raw/master-data/materials —
 *   Header export_type MASTER_CONTENT|MASTER_STRUCTURE, table_name MARA|MARC|MARD|MVKE|MARM,
 *   schema_version 2.8, profile MATERIAL, system_id Q01
 * - Customers RAW (P01, 2026-08-04): 8 JSONL unter raw/master-data/customers —
 *   table_name KNA1|KNVV|KNVP|KNVH, profile CUSTOMER, schema 2.8
 * - Vendors RAW (P01, 2026-08-04): 4 JSONL unter raw/master-data/vendors —
 *   table_name LFA1|LFM1, profile VENDOR, schema 2.3
 * - Programs RAW (P01, 2026-08-03): raw/programs/*_SAP_PROGRAMS_CONTENT.jsonl
 *   Header export_type=SAP_PROGRAMS, schema 2.2, record_types header|source_object|code_unit|relation
 * - Function Modules RAW (P01, 2026-08-03): raw/programs/*_SAP_FUNCTION_MODULES_CONTENT.jsonl
 *   Header export_type=SAP_FUNCTION_MODULES, schema 2.2 (gleicher Ordner, Header maßgeblich)
 * - App SSOT folders: RAW_FOLDER_SPECS / localData zones
 */

export type RuleCertainty = "verified" | "inferred_from_raw" | "unknown";

export type ExportTypeImplementation = "full" | "prepared" | "locked";

export type HeaderFieldRule = {
  required: boolean;
  /** Exact expected value when known; null = nonempty string only. */
  exact?: string | null;
  certainty: RuleCertainty;
  note?: string;
};

export type ExportTypeConfig = {
  id: string;
  title: string;
  description: string;
  /** Unlock order (0 = first). */
  orderIndex: number;
  implementation: ExportTypeImplementation;
  certainty: RuleCertainty;
  /**
   * When true, unlocks with Stage 2 (parallel) and does not participate in
   * the sequential approval chain (classes → programs → …).
   */
  unlockIndependent?: boolean;
  sapReport: string | null;
  sapObjectHint: string | null;
  /** Relative under project, e.g. raw/classes — app folder SSOT. */
  rawFolder: string | null;
  rawFolderParts: string[] | null;
  minFiles: number | null;
  maxFiles: number | null;
  extensions: string[] | null;
  /**
   * Filename regex — only when evidenced. null = do not pattern-match names;
   * detect via folder + count + header.
   */
  filenamePattern: RegExp | null;
  filenamePatternCertainty: RuleCertainty;
  /** Observed example only — not a rule. */
  observedFilenameExample: string | null;
  headerExportType: string | null;
  headerRules: Record<string, HeaderFieldRule> | null;
  canonicalOutputs: string[] | null;
  evidenceNotes: string[];
};

/**
 * Ordered export types. Phase 1: classes = full; programs = prepared (locked until
 * classes approved); remaining = locked scaffold with certainty unknown.
 */
export const EXPORT_TYPE_CONFIGS: readonly ExportTypeConfig[] = [
  {
    id: "classes",
    title: "Klassen",
    description:
      "Repository-Export Klassen + Quelltextfragmente (Z_AI_REPOSITORY_EXPORT)",
    orderIndex: 0,
    implementation: "full",
    certainty: "inferred_from_raw",
    sapReport: "Z_AI_REPOSITORY_EXPORT",
    sapObjectHint: "Klassen",
    rawFolder: "raw/classes",
    rawFolderParts: ["classes"],
    minFiles: 1,
    maxFiles: null, // App may select among multiple; prefer 1, allow select if several
    extensions: [".jsonl"],
    filenamePattern: null, // no invented *CLASS* / ABAP grammar without source
    filenamePatternCertainty: "unknown",
    observedFilenameExample: "D01_20260804_025228_SAP_CLASSES_CONTENT.jsonl",
    headerExportType: "SAP_CLASSES",
    headerRules: {
      record_type: {
        required: true,
        exact: "header",
        certainty: "inferred_from_raw",
      },
      export_type: {
        required: true,
        exact: "SAP_CLASSES",
        certainty: "inferred_from_raw",
        note: "Dateiname enthält export_type oft nicht — Header ist maßgeblich",
      },
      system_id: {
        required: true,
        exact: null,
        certainty: "inferred_from_raw",
      },
      schema_version: {
        required: true,
        exact: null,
        certainty: "inferred_from_raw",
        note: "Beobachtet: \"1.0\" (Test) und \"2.8\" (Voll-Export) — Wert-Pin erst nach mehr Samples",
      },
    },
    canonicalOutputs: [
      "canonical/classes/source_objects.jsonl",
      "canonical/classes/source_fragments.jsonl",
      "canonical/classes/code_units.jsonl",
      "canonical/classes/relations.jsonl",
      "canonical/classes/ingest_report.json",
    ],
    evidenceNotes: [
      "Header export_type=SAP_CLASSES aus RAW P01/raw/classes/",
      "Ordner raw/classes = App-SSOT (RAW_FOLDER_SPECS); Unterordner _quarantine wird ignoriert",
      "Aktives Sample: D01_*_SAP_CLASSES_CONTENT.jsonl (schema_version 2.8, object_count≃965)",
      "Früheres 1-Klassen-Testfile sap_classes2.jsonl — nicht mehr aktiv",
    ],
  },
  {
    id: "programs",
    title: "Programme",
    description:
      "RAW erkennen → streaming validieren → Canonical unter canonical/programs (ohne OpenAI)",
    orderIndex: 1,
    implementation: "full",
    certainty: "inferred_from_raw",
    unlockIndependent: true,
    sapReport: "Z_AI_REPOSITORY_EXPORT",
    sapObjectHint: "Programme",
    rawFolder: "raw/programs",
    rawFolderParts: ["programs"],
    minFiles: 1,
    maxFiles: null,
    extensions: [".jsonl"],
    filenamePattern: null,
    filenamePatternCertainty: "unknown",
    observedFilenameExample:
      "Q01_20260803_233642_SAP_PROGRAMS_CONTENT.jsonl",
    headerExportType: "SAP_PROGRAMS",
    headerRules: {
      record_type: {
        required: true,
        exact: "header",
        certainty: "inferred_from_raw",
      },
      export_type: {
        required: true,
        exact: "SAP_PROGRAMS",
        certainty: "inferred_from_raw",
        note: "Dateiname nur Hinweis — Header ist maßgeblich (Ordner teilt sich mit FMs)",
      },
      system_id: {
        required: true,
        exact: null,
        certainty: "inferred_from_raw",
      },
      schema_version: {
        required: true,
        exact: null,
        certainty: "inferred_from_raw",
        note: "Beobachtet: 2.2",
      },
    },
    canonicalOutputs: [
      "canonical/programs/source_objects.jsonl",
      "canonical/programs/code_units.jsonl",
      "canonical/programs/relations.jsonl",
      "canonical/programs/extracts.jsonl",
      "canonical/programs/ingest_report.json",
      "canonical/programs/stats.json",
    ],
    evidenceNotes: [
      "P01 Sample 2026-08-03: SAP_PROGRAMS schema 2.2, object_count 2493",
      "record_types: header|source_object|code_unit|relation (FULL_PROGRAM)",
      "Relationen RAW: PROGRAM INCLUDES INCLUDE; Derived: FORM/CALLS_*/READS_TABLE",
      "Pipeline parallel (unlockIndependent); kein OpenAI / Index / Embeddings",
    ],
  },
  {
    id: "function-modules",
    title: "Funktionsbausteine",
    description:
      "RAW erkennen → streaming validieren → Canonical unter canonical/function-modules (ohne OpenAI)",
    orderIndex: 2,
    implementation: "full",
    certainty: "inferred_from_raw",
    unlockIndependent: true,
    sapReport: "Z_AI_REPOSITORY_EXPORT",
    sapObjectHint: "Funktionsbausteine",
    rawFolder: "raw/programs",
    rawFolderParts: ["programs"],
    minFiles: 1,
    maxFiles: null,
    extensions: [".jsonl"],
    filenamePattern: null,
    filenamePatternCertainty: "unknown",
    observedFilenameExample:
      "Q01_20260803_233711_SAP_FUNCTION_MODULES_CONTENT.jsonl",
    headerExportType: "SAP_FUNCTION_MODULES",
    headerRules: {
      record_type: {
        required: true,
        exact: "header",
        certainty: "inferred_from_raw",
      },
      export_type: {
        required: true,
        exact: "SAP_FUNCTION_MODULES",
        certainty: "inferred_from_raw",
        note: "Liegt unter raw/programs — Header filtert gegen SAP_PROGRAMS",
      },
      system_id: {
        required: true,
        exact: null,
        certainty: "inferred_from_raw",
      },
      schema_version: {
        required: true,
        exact: null,
        certainty: "inferred_from_raw",
        note: "Beobachtet: 2.2",
      },
    },
    canonicalOutputs: [
      "canonical/function-modules/source_objects.jsonl",
      "canonical/function-modules/code_units.jsonl",
      "canonical/function-modules/relations.jsonl",
      "canonical/function-modules/extracts.jsonl",
      "canonical/function-modules/ingest_report.json",
      "canonical/function-modules/stats.json",
    ],
    evidenceNotes: [
      "P01 Sample 2026-08-03: SAP_FUNCTION_MODULES schema 2.2, object_count 800",
      "source_object.main_program = Function Group; include_name auf code_unit",
      "Relationen RAW: BELONGS_TO FUNCTION_GROUP_PROGRAM; Derived: IMPLEMENTED_IN_INCLUDE",
      "Pipeline parallel (unlockIndependent); kein OpenAI / Index / Embeddings",
    ],
  },
  {
    id: "user-exits",
    title: "User-Exits",
    description: "Scaffold — Regeln aus ABAP/RAW ausstehend",
    orderIndex: 3,
    implementation: "locked",
    certainty: "unknown",
    sapReport: "Z_AI_REPOSITORY_EXPORT",
    sapObjectHint: null,
    rawFolder: null,
    rawFolderParts: null,
    minFiles: null,
    maxFiles: null,
    extensions: null,
    filenamePattern: null,
    filenamePatternCertainty: "unknown",
    observedFilenameExample: null,
    headerExportType: null,
    headerRules: null,
    canonicalOutputs: null,
    evidenceNotes: ["Keine belegten Ordner-/Header-Regeln"],
  },
  {
    id: "badis",
    title: "BAdIs",
    description: "Scaffold — Regeln aus ABAP/RAW ausstehend",
    orderIndex: 4,
    implementation: "locked",
    certainty: "unknown",
    sapReport: "Z_AI_REPOSITORY_EXPORT",
    sapObjectHint: null,
    rawFolder: null,
    rawFolderParts: null,
    minFiles: null,
    maxFiles: null,
    extensions: null,
    filenamePattern: null,
    filenamePatternCertainty: "unknown",
    observedFilenameExample: null,
    headerExportType: null,
    headerRules: null,
    canonicalOutputs: null,
    evidenceNotes: ["Keine belegten Ordner-/Header-Regeln"],
  },
  {
    id: "enhancements",
    title: "Enhancements",
    description: "Scaffold — Regeln aus ABAP/RAW ausstehend",
    orderIndex: 5,
    implementation: "locked",
    certainty: "unknown",
    sapReport: "Z_AI_REPOSITORY_EXPORT",
    sapObjectHint: null,
    rawFolder: null,
    rawFolderParts: null,
    minFiles: null,
    maxFiles: null,
    extensions: null,
    filenamePattern: null,
    filenamePatternCertainty: "unknown",
    observedFilenameExample: null,
    headerExportType: null,
    headerRules: null,
    canonicalOutputs: null,
    evidenceNotes: ["Keine belegten Ordner-/Header-Regeln"],
  },
  {
    id: "control-tables",
    title: "Z-/Y-Tabellen",
    description:
      "Control Tables — bestehender CT-Fahrplan; Datenbasis-Scaffold (Phase 1 nicht dupliziert)",
    orderIndex: 6,
    implementation: "prepared",
    certainty: "inferred_from_raw",
    sapReport: "Z_AI_REPOSITORY_EXPORT",
    sapObjectHint: "Z-/Y-Tabellen",
    rawFolder: "raw/control-tables",
    rawFolderParts: ["control-tables"],
    minFiles: null,
    maxFiles: null,
    extensions: [".jsonl"],
    filenamePattern: null,
    filenamePatternCertainty: "unknown",
    observedFilenameExample: "sap_z_control_tables_Q01.jsonl",
    headerExportType: "SAP_Z_CONTROL_TABLES",
    headerRules: {
      record_type: {
        required: true,
        exact: "header",
        certainty: "inferred_from_raw",
      },
      export_type: {
        required: true,
        exact: "SAP_Z_CONTROL_TABLES",
        certainty: "inferred_from_raw",
      },
      system_id: {
        required: true,
        exact: null,
        certainty: "inferred_from_raw",
      },
      schema_version: {
        required: true,
        exact: null,
        certainty: "inferred_from_raw",
      },
    },
    canonicalOutputs: null,
    evidenceNotes: [
      "Phase 1: kein zweiter CT-Pipeline-Duplikat — bestehender Fahrplan bleibt",
      "Header SAP_Z_CONTROL_TABLES aus RAW-Samples definitions/contents",
      "Dateinamensmuster nicht als kanonische Regel ohne ABAP",
    ],
  },
  {
    id: "master-data",
    title: "Stammdaten (Rahmen)",
    description:
      "Rahmen-Ordner; konkrete Pipelines: materials / customers / vendors",
    orderIndex: 7,
    implementation: "locked",
    certainty: "unknown",
    sapReport: null,
    sapObjectHint: null,
    rawFolder: "raw/master-data",
    rawFolderParts: ["master-data"],
    minFiles: null,
    maxFiles: null,
    extensions: null,
    filenamePattern: null,
    filenamePatternCertainty: "unknown",
    observedFilenameExample: null,
    headerExportType: null,
    headerRules: null,
    canonicalOutputs: null,
    evidenceNotes: [
      "Rahmen — materials|customers|vendors = eigene Exporttypen",
      "Keine erfundenen MARA/STRUCTURE/CONTENT/MAX/LIMITED-Regeln",
    ],
  },
  {
    id: "materials",
    title: "Materialstammdaten",
    description:
      "RAW erkennen → streaming validieren → Canonical unter canonical/master-data/materials (ohne OpenAI)",
    orderIndex: 8,
    implementation: "full",
    certainty: "inferred_from_raw",
    unlockIndependent: true,
    sapReport: null,
    sapObjectHint: "Materialstammdaten",
    rawFolder: "raw/master-data/materials",
    rawFolderParts: ["master-data", "materials"],
    minFiles: 10,
    maxFiles: null,
    extensions: [".jsonl"],
    // Filename hints observed; Header (table_name + export_type) bleibt maßgeblich.
    filenamePattern: /_MATERIAL_(MARA|MARC|MARD|MVKE|MARM)_(CONTENT|STRUCTURE)\.jsonl$/i,
    filenamePatternCertainty: "inferred_from_raw",
    observedFilenameExample:
      "Q01_20260804_010000_MATERIAL_MARA_CONTENT.jsonl",
    // Zwei Werte belegt — kein einzelnes headerExportType-Pin.
    headerExportType: null,
    headerRules: {
      record_type: {
        required: true,
        exact: "header",
        certainty: "inferred_from_raw",
      },
      export_type: {
        required: true,
        exact: null,
        certainty: "inferred_from_raw",
        note: "Belegt: MASTER_CONTENT | MASTER_STRUCTURE (Pipeline prüft oneOf)",
      },
      system_id: {
        required: true,
        exact: null,
        certainty: "inferred_from_raw",
      },
      schema_version: {
        required: true,
        exact: null,
        certainty: "inferred_from_raw",
        note: "Beobachtet: 2.8",
      },
      table_name: {
        required: true,
        exact: null,
        certainty: "inferred_from_raw",
        note: "Belegt: MARA|MARC|MARD|MVKE|MARM",
      },
    },
    canonicalOutputs: [
      "canonical/master-data/materials/header.json",
      "canonical/master-data/materials/records.jsonl",
      "canonical/master-data/materials/ingest_report.json",
      "canonical/master-data/materials/MARA/content.jsonl",
      "canonical/master-data/materials/MARA/structure.jsonl",
      "canonical/master-data/materials/MARC/content.jsonl",
      "canonical/master-data/materials/MARC/structure.jsonl",
      "canonical/master-data/materials/MARD/content.jsonl",
      "canonical/master-data/materials/MARD/structure.jsonl",
      "canonical/master-data/materials/MVKE/content.jsonl",
      "canonical/master-data/materials/MVKE/structure.jsonl",
      "canonical/master-data/materials/MARM/content.jsonl",
      "canonical/master-data/materials/MARM/structure.jsonl",
    ],
    evidenceNotes: [
      "Ordner raw/master-data/materials = App-SSOT (RAW_FOLDER_SPECS.materials)",
      "P01 Sample 2026-08-04: 10 JSONL, system_id=Q01, profile=MATERIAL, schema 2.8",
      "Header export_type MASTER_CONTENT|MASTER_STRUCTURE; table_name MARA|MARC|MARD|MVKE|MARM",
      "Body: master_data_row+values (CONTENT) / master_field_definition+field_name (STRUCTURE)",
      "Pipeline parallel zu classes (unlockIndependent); RAG/Embeddings bewusst nicht",
    ],
  },
  {
    id: "customers",
    title: "Kundenstammdaten",
    description:
      "RAW erkennen → validieren → Canonical unter canonical/master-data/customers (ohne OpenAI)",
    orderIndex: 9,
    implementation: "full",
    certainty: "inferred_from_raw",
    unlockIndependent: true,
    sapReport: null,
    sapObjectHint: "Kundenstammdaten",
    rawFolder: "raw/master-data/customers",
    rawFolderParts: ["master-data", "customers"],
    minFiles: 8,
    maxFiles: null,
    extensions: [".jsonl"],
    filenamePattern:
      /_CUSTOMER_(KNA1|KNVV|KNVP|KNVH)_(CONTENT|STRUCTURE)\.jsonl$/i,
    filenamePatternCertainty: "inferred_from_raw",
    observedFilenameExample:
      "Q01_20260804_010028_CUSTOMER_KNA1_CONTENT.jsonl",
    headerExportType: null,
    headerRules: {
      record_type: {
        required: true,
        exact: "header",
        certainty: "inferred_from_raw",
      },
      export_type: {
        required: true,
        exact: null,
        certainty: "inferred_from_raw",
        note: "Belegt: MASTER_CONTENT | MASTER_STRUCTURE",
      },
      system_id: {
        required: true,
        exact: null,
        certainty: "inferred_from_raw",
      },
      schema_version: {
        required: true,
        exact: null,
        certainty: "inferred_from_raw",
        note: "Beobachtet: 2.8",
      },
      table_name: {
        required: true,
        exact: null,
        certainty: "inferred_from_raw",
        note: "Belegt: KNA1|KNVV|KNVP|KNVH",
      },
    },
    canonicalOutputs: [
      "canonical/master-data/customers/header.json",
      "canonical/master-data/customers/records.jsonl",
      "canonical/master-data/customers/relations.jsonl",
      "canonical/master-data/customers/ingest_report.json",
      "canonical/master-data/customers/KNA1/content.jsonl",
      "canonical/master-data/customers/KNA1/structure.jsonl",
      "canonical/master-data/customers/KNVV/content.jsonl",
      "canonical/master-data/customers/KNVV/structure.jsonl",
      "canonical/master-data/customers/KNVP/content.jsonl",
      "canonical/master-data/customers/KNVP/structure.jsonl",
      "canonical/master-data/customers/KNVH/content.jsonl",
      "canonical/master-data/customers/KNVH/structure.jsonl",
    ],
    evidenceNotes: [
      "Ordner raw/master-data/customers — 8 JSONL (KNA1/KNVV/KNVP/KNVH × STRUCTURE+CONTENT)",
      "P01 Sample 2026-08-04: system_id=Q01, profile=CUSTOMER, schema 2.8",
      "Relationen: KNA1 zentral; KNA1→KNVV; KNVV→KNVP; KNVV/KNA1→KNVH",
      "Keys: KUNNR, VKORG, VTWEG, SPART, PARVW, Hierarchie (HITYP/DATAB/HKUNNR)",
      "Pipeline parallel (unlockIndependent); kein OpenAI / Index",
    ],
  },
  {
    id: "vendors",
    title: "Lieferantenstammdaten",
    description:
      "RAW erkennen → validieren → Canonical unter canonical/master-data/vendors (ohne OpenAI)",
    orderIndex: 10,
    implementation: "full",
    certainty: "inferred_from_raw",
    unlockIndependent: true,
    sapReport: null,
    sapObjectHint: "Lieferantenstammdaten",
    rawFolder: "raw/master-data/vendors",
    rawFolderParts: ["master-data", "vendors"],
    minFiles: 4,
    maxFiles: null,
    extensions: [".jsonl"],
    filenamePattern: /_VENDOR_(LFA1|LFM1)_(CONTENT|STRUCTURE)\.jsonl$/i,
    filenamePatternCertainty: "inferred_from_raw",
    observedFilenameExample:
      "Q01_20260804_010046_VENDOR_LFA1_CONTENT.jsonl",
    headerExportType: null,
    headerRules: {
      record_type: {
        required: true,
        exact: "header",
        certainty: "inferred_from_raw",
      },
      export_type: {
        required: true,
        exact: null,
        certainty: "inferred_from_raw",
        note: "Belegt: MASTER_CONTENT | MASTER_STRUCTURE",
      },
      system_id: {
        required: true,
        exact: null,
        certainty: "inferred_from_raw",
      },
      schema_version: {
        required: true,
        exact: null,
        certainty: "inferred_from_raw",
        note: "Beobachtet: 2.3",
      },
      table_name: {
        required: true,
        exact: null,
        certainty: "inferred_from_raw",
        note: "Belegt: LFA1|LFM1",
      },
    },
    canonicalOutputs: [
      "canonical/master-data/vendors/header.json",
      "canonical/master-data/vendors/records.jsonl",
      "canonical/master-data/vendors/relations.jsonl",
      "canonical/master-data/vendors/ingest_report.json",
      "canonical/master-data/vendors/LFA1/content.jsonl",
      "canonical/master-data/vendors/LFA1/structure.jsonl",
      "canonical/master-data/vendors/LFM1/content.jsonl",
      "canonical/master-data/vendors/LFM1/structure.jsonl",
    ],
    evidenceNotes: [
      "Ordner raw/master-data/vendors — 4 JSONL (LFA1/LFM1 × STRUCTURE+CONTENT)",
      "P01 Sample 2026-08-04: system_id=Q01, profile=VENDOR, schema 2.3",
      "Relationen: LFA1 zentral; LFA1→LFM1; Keys LIFNR, EKORG",
      "Pipeline parallel (unlockIndependent); kein OpenAI / Index",
    ],
  },
  {
    id: "message-idoc-config",
    title: "Nachrichten- und IDoc-Konfiguration",
    description:
      "10 Exportgruppen (MESSAGE_IDOC_01…10): Header-Validierung und Schema-Profiling je Quelltabelle (ohne Canonical-Zwang, ohne OpenAI/Index)",
    orderIndex: 11,
    implementation: "prepared",
    certainty: "inferred_from_raw",
    unlockIndependent: true,
    sapReport: null,
    sapObjectHint: "Nachrichtensteuerung / ALE / IDoc-Konfiguration",
    rawFolder: "raw/message-idoc-config",
    rawFolderParts: ["message-idoc-config"],
    minFiles: 10,
    maxFiles: 10,
    extensions: [".jsonl"],
    filenamePattern: null,
    filenamePatternCertainty: "unknown",
    observedFilenameExample:
      "D01_20260805_151000_MESSAGE_IDOC_01_OUTPUT_TYPES.jsonl",
    headerExportType: "MESSAGE_IDOC_CONFIG",
    headerRules: {
      record_type: {
        required: true,
        exact: "header",
        certainty: "inferred_from_raw",
      },
      export_type: {
        required: true,
        exact: "MESSAGE_IDOC_CONFIG",
        certainty: "inferred_from_raw",
      },
      config_group: {
        required: true,
        exact: null,
        certainty: "inferred_from_raw",
        note: "Eine von 10 MESSAGE_IDOC_0x_… Gruppen",
      },
      movement_data_included: {
        required: true,
        exact: "false",
        certainty: "inferred_from_raw",
      },
      object_selection_applied: {
        required: true,
        exact: "false",
        certainty: "inferred_from_raw",
        note: "S_OBJ bewusst nicht verwendet",
      },
    },
    canonicalOutputs: [
      "canonical/message-idoc-config/ (geplant — Mapping ausstehend)",
    ],
    evidenceNotes: [
      "Pipeline-Typ MESSAGE_IDOC_CONFIG — genau 10 config_groups",
      "Dateiname dynamisch: <SYSTEM>_<YYYYMMDD>_<HHMMSS>_<GRUPPE>.jsonl",
      "Erkennung über Gruppensuffix + Header config_group",
      "Mehrere Quelltabellen pro Datei — Profil je Gruppe×Tabelle",
      "Keine EDIDC/EDID4/EDIDS; kein Z-/Y-Dateifilter",
      "Prepare: Detect → Validate → Schema-Profile → Manifest; kein Convert/Index",
    ],
  },
] as const;

export type ExportTypeId = (typeof EXPORT_TYPE_CONFIGS)[number]["id"];

export function listExportTypeConfigs(): ExportTypeConfig[] {
  return [...EXPORT_TYPE_CONFIGS].sort((a, b) => a.orderIndex - b.orderIndex);
}

export function getExportTypeConfig(id: string): ExportTypeConfig | null {
  return EXPORT_TYPE_CONFIGS.find((c) => c.id === id) ?? null;
}

export function isExportTypeId(raw: string | undefined): raw is ExportTypeId {
  return Boolean(raw && EXPORT_TYPE_CONFIGS.some((c) => c.id === raw));
}

/** RAW subfolders to scaffold under project (empty dirs only — never invent files). */
export function listScaffoldRawFolderParts(): string[][] {
  return [
    ["classes"],
    ["programs"],
    ["control-tables", "definitions"],
    ["control-tables", "contents"],
    ["master-data", "materials"],
    ["master-data", "customers"],
    ["master-data", "vendors"],
    ["message-idoc-config"],
  ];
}

export const DATENBASIS_STEP_META: Record<
  string,
  { title: string; shortTitle: string; description: string; actionLabel: string }
> = {
  A_sap_export: {
    title: "SAP-Export anweisen",
    shortTitle: "SAP",
    description:
      "Report Z_AI_REPOSITORY_EXPORT ausführen und JSONL unter raw/ ablegen",
    actionLabel: "Export bestätigt",
  },
  B_raw_detect: {
    title: "RAW erkennen",
    shortTitle: "RAW",
    description: "Ordner, Dateianzahl und JSONL-Header prüfen",
    actionLabel: "RAW prüfen",
  },
  C_validate: {
    title: "JSONL validieren",
    shortTitle: "Validieren",
    description: "Streaming-Validierung der Quelldatei",
    actionLabel: "Validieren",
  },
  D_convert: {
    title: "Konvertieren",
    shortTitle: "Konvertieren",
    description: "RAW → Canonical (RAW unverändert)",
    actionLabel: "Konvertieren",
  },
  E_test_questions: {
    title: "Testdaten-Fragen",
    shortTitle: "Fragen",
    description: "Drei datenbasierte Testfragen aus Canonical",
    actionLabel: "Fragen prüfen",
  },
  F_rag_test: {
    title: "RAG-Test",
    shortTitle: "RAG",
    description: "Direct-RAG-Smoke gegen Index/Wissen",
    actionLabel: "RAG testen",
  },
  G_approve: {
    title: "Freigabe",
    shortTitle: "Freigabe",
    description: "Manuelle Freigabe — entsperrt nächsten Exporttyp",
    actionLabel: "Freigeben",
  },
};
