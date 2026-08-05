/** Datenbasis export-type pipeline (Stage 3) — types only. */

export const DATENBASIS_STEP_IDS = [
  "A_sap_export",
  "B_raw_detect",
  "C_validate",
  "D_convert",
  "E_test_questions",
  "F_rag_test",
  "G_approve",
] as const;

export type DatenbasisStepId = (typeof DATENBASIS_STEP_IDS)[number];

export type DatenbasisStepStatus =
  | "locked"
  | "open"
  | "ready"
  | "running"
  | "done"
  | "error"
  | "awaiting";

export type DatenbasisOverallStatus =
  | "locked"
  | "not_started"
  | "in_progress"
  | "awaiting_approval"
  | "approved"
  | "failed";

export type DatenbasisStepKind = "manual" | "technical";

export type DatenbasisStepResult = {
  summary: string;
  hint?: string;
  ok?: boolean;
  report_path?: string;
  files?: Array<{
    relativePath: string;
    fileName: string;
    bytes: number;
    selected?: boolean;
  }>;
  counts?: Record<string, number>;
  warnings?: string[];
  errors?: string[];
  cases?: Array<{
    question: string;
    ok: boolean;
    detail: string;
  }>;
  samples?: Array<{
    query: string;
    ok: boolean;
    detail: string;
  }>;
  technical?: Record<string, unknown>;
};

export type DatenbasisStepState = {
  id: DatenbasisStepId;
  kind: DatenbasisStepKind;
  status: DatenbasisStepStatus;
  result: DatenbasisStepResult | null;
  confirmed_at?: string | null;
  approved_at?: string | null;
  updated_at: string | null;
};

export type DatenbasisManifest = {
  schema_version: 1;
  project: string;
  export_type: string;
  order_index: number;
  unlocked: boolean;
  overall: DatenbasisOverallStatus;
  source_fingerprint: string | null;
  selected_raw_file: string | null;
  raw_immutable: true;
  steps: Record<DatenbasisStepId, DatenbasisStepState>;
  updated_at: string;
};

export type SetupStage2State = {
  schema_version: 1;
  project: string;
  folders_ok: boolean;
  folders_checked_at: string | null;
  manual_complete: boolean;
  manual_complete_at: string | null;
  created_paths: string[];
  missing_paths: string[];
  updated_at: string;
};

export type DatenbasisTypeCard = {
  id: string;
  title: string;
  description: string;
  orderIndex: number;
  implementation: "full" | "prepared" | "locked";
  certainty: "verified" | "inferred_from_raw" | "unknown";
  unlocked: boolean;
  overall: DatenbasisOverallStatus;
  progressPercent: number;
  nextStepId: DatenbasisStepId | null;
  nextActionLabel: string;
  href: string;
  sapReport: string | null;
  rawFolder: string | null;
};

export type DatenbasisOverview = {
  projectKey: string;
  types: DatenbasisTypeCard[];
  doneCount: number;
  totalCount: number;
  /** Progress only over types with implementation !== locked that are in unlock order. */
  progressPercent: number;
  area3Done: boolean;
  localDataError: string | null;
};
