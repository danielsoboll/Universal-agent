/** Operative Admin-Checkliste „Unternehmenswissen extrahieren“. */

export type WorkflowStepStatus =
  | "nicht_begonnen"
  | "bereit"
  | "in_arbeit"
  | "wartet_auf_datei"
  | "pruefung_laeuft"
  | "fehler"
  | "blockiert"
  | "abgeschlossen"
  | "uebersprungen";

export type WorkflowStepType =
  | "manual_instruction"
  | "file_delivery"
  | "validation"
  | "pipeline_action"
  | "review"
  | "approval";

export type ExecutionLocation =
  | "SAP GUI"
  | "lokaler Rechner"
  | "Admin-App"
  | "Supabase"
  | "externes System"
  | "CLI";

export type WorkflowActionId =
  | "copy_report"
  | "copy_parameters"
  | "copy_path"
  | "copy_value"
  | "open_guide"
  | "select_files"
  | "open_folder"
  | "validate_files"
  | "start_pipeline"
  | "open_report"
  | "show_errors"
  | "retry"
  | "mark_done"
  | "grant_approval";

export type WorkflowParameter = {
  key: string;
  value: string;
};

/** Statische Schrittdefinition (Template, Platzhalter erlaubt). */
export type WorkflowStepDefinition = {
  id: string;
  phase: string;
  phase_order: number;
  sequence: number;
  title: string;
  short_description: string;
  step_type: WorkflowStepType;
  execution_location: ExecutionLocation;
  system_name: string;
  transaction_or_report: string;
  variant: string;
  parameters: WorkflowParameter[];
  expected_input: string;
  expected_output: string;
  destination_path: string;
  file_patterns: string[];
  app_action: string;
  success_criteria: string[];
  warning_text: string;
  troubleshooting: string[];
  /** Pipeline-Registry-Key, falls vorhanden. */
  pipeline_key?: string | null;
  /** npm-Script aus package.json. */
  npm_script?: string | null;
  /** Vollständiger CLI-Hinweis (nach Platzhalter-Auflösung). */
  cli_command?: string | null;
  actions: WorkflowActionId[];
  depends_on: string[];
  /** Relative Pfade unter PROJECT_DATA_ROOT für Erfolgskontrolle. */
  output_checks?: string[];
};

export type WorkflowProcessDefinition = {
  id: string;
  title: string;
  description: string;
  steps: WorkflowStepDefinition[];
};

export type StepCheckResult = {
  at: string;
  ok: boolean;
  messages: string[];
  matched_files?: string[];
};

export type WorkflowStepState = {
  status: WorkflowStepStatus;
  completed_at: string | null;
  notes: string;
  manual_confirmed: boolean;
  last_check: StepCheckResult | null;
  last_run_log?: string | null;
};

export type WorkflowRuntimeState = {
  process_id: string;
  project_id: string;
  updated_at: string;
  steps: Record<string, WorkflowStepState>;
};

/** Zentral in der Projektkonfiguration. */
export type ProjectProcessConfig = {
  sap_system_label: string;
  repository_export_report: string;
  repository_export_variant: string;
  table_definition_export_report: string;
  table_content_export_report: string;
  table_export_variant: string;
  object_prefixes: string;
  repository_raw_path: string;
  table_definitions_raw_path: string;
  table_contents_raw_path: string;
};

export const UNCONFIGURED = "noch zu konfigurieren";

export const DEFAULT_PROCESS_CONFIG: ProjectProcessConfig = {
  sap_system_label: "Entwicklungssystem (${SYSTEM_ID})",
  repository_export_report: "",
  repository_export_variant: "",
  table_definition_export_report: "",
  table_content_export_report: "",
  table_export_variant: "",
  object_prefixes: "Z*, Y*",
  repository_raw_path: "raw/classes",
  table_definitions_raw_path: "raw/control-tables/definitions",
  table_contents_raw_path: "raw/control-tables/contents",
};

export const WORKFLOW_STATUS_LABELS: Record<WorkflowStepStatus, string> = {
  nicht_begonnen: "nicht begonnen",
  bereit: "bereit",
  in_arbeit: "in Arbeit",
  wartet_auf_datei: "wartet auf Datei",
  pruefung_laeuft: "Prüfung läuft",
  fehler: "Fehler",
  blockiert: "blockiert",
  abgeschlossen: "abgeschlossen",
  uebersprungen: "übersprungen",
};

export const WORKFLOW_STEP_TYPE_LABELS: Record<WorkflowStepType, string> = {
  manual_instruction: "Manuelle Anweisung",
  file_delivery: "Dateiablage",
  validation: "Prüfung",
  pipeline_action: "Pipeline",
  review: "Review",
  approval: "Freigabe",
};
