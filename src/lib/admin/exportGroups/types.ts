/** Shared export-group model for Hauptschritte 3–5 (frame + status). */

export const EXPORT_GROUP_IDS = [
  "zy-tables",
  "classes-repo",
  "master-data",
] as const;

export type ExportGroupId = (typeof EXPORT_GROUP_IDS)[number];

export type PointStatus =
  | "open"
  | "locked"
  | "in_progress"
  | "error"
  | "done";

export type ExportGroupPipeline = "control-tables" | "prepared";

/** Static definition — no invented SAP validation rules. */
export type ExportGroupDefinition = {
  id: ExportGroupId;
  title: string;
  description: string;
  sapReport: string;
  exportType: string;
  expectedSourceFiles: string[];
  rawTargetPaths: string[];
  dependencies: ExportGroupId[];
  /** Gates Hauptschritt 3–5 completion until converters exist for others. */
  requiredForMainProgress: boolean;
  pipeline: ExportGroupPipeline;
  /** Optional subtype labels (frame only — no convert logic). */
  preparedSubtypes?: string[];
};

export type FlowPointKind = "org" | "tech" | "info";

export type FlowPoint = {
  id: string;
  label: string;
  kind: FlowPointKind;
  status: PointStatus;
  detail?: string;
  /** Org points may be toggled by Projekt-Admin. */
  confirmable?: boolean;
};

export type ValidationStageId =
  | "source_recognized"
  | "raw_checked"
  | "data_converted"
  | "canonical_checked";

export type ValidationStage = {
  id: ValidationStageId;
  label: string;
  status: PointStatus;
  detail?: string;
};

export type FeintuningStageId =
  | "knowledge_build"
  | "search_documents"
  | "embeddings"
  | "index_update"
  | "direct_search"
  | "deep_search"
  | "plausibilize";

export type FeintuningStage = {
  id: FeintuningStageId;
  label: string;
  status: PointStatus;
  detail?: string;
};

export type ExportGroupState = {
  id: ExportGroupId;
  title: string;
  description: string;
  sapReport: string;
  exportType: string;
  expectedSourceFiles: string[];
  rawTargetPaths: string[];
  organizationalStatus: PointStatus;
  technicalStatus: PointStatus;
  progressPercent: number;
  dependencies: ExportGroupId[];
  detailPageLink: string;
  requiredForMainProgress: boolean;
  pipeline: ExportGroupPipeline;
  preparedSubtypes?: string[];
  /** Area 3: system recognized expected RAW sources. */
  fullyRecognized: boolean;
  operationalFlow: FlowPoint[];
  /** Extra Z-/Y detail checklist (org + tech). */
  recognitionDetail: FlowPoint[];
  nextAction: string;
  validation: {
    locked: boolean;
    stages: ValidationStage[];
    progressPercent: number;
    fullyValidated: boolean;
  };
  feintuning: {
    locked: boolean;
    stages: FeintuningStage[];
    progressPercent: number;
    fullyTuned: boolean;
  };
};

export type ExportGroupsOverview = {
  projectKey: string;
  groups: ExportGroupState[];
  area3Percent: number;
  area4Percent: number;
  area5Percent: number;
  area3Done: boolean;
  area4Done: boolean;
  area5Done: boolean;
  localDataError: string | null;
};

/** Persisted manual org confirmations under logs/. */
export type ExportGroupsOrgState = {
  schema_version: 1;
  project: string;
  updated_at: string;
  groups: Partial<
    Record<
      ExportGroupId,
      Partial<Record<string, { confirmed: boolean; at: string }>>
    >
  >;
};
