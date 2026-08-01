export const REBUILD_DATA_TYPES = [
  "control-tables",
  "classes",
  "programs",
  "materials",
  "customers",
  "vendors",
] as const;

export type RebuildDataType = (typeof REBUILD_DATA_TYPES)[number];

/** Transactional prepare-then-swap status (Admin UI). */
export const REBUILD_STATUS_STEPS = [
  "raw_validated",
  "data_prepared",
  "old_wiped",
  "new_built",
  "index_updated",
  "done",
] as const;

export type RebuildStatusStep = (typeof REBUILD_STATUS_STEPS)[number];

export const REBUILD_STATUS_LABELS_DE: Record<RebuildStatusStep, string> = {
  raw_validated: "RAW geprüft",
  data_prepared: "Daten vorbereitet",
  old_wiped: "alter Wissensstand gelöscht",
  new_built: "neuer Wissensstand aufgebaut",
  index_updated: "Index aktualisiert",
  done: "fertig",
};

export type RawSourceFile = {
  relativePath: string;
  fileName: string;
  absolutePath: string;
  bytes: number;
  sha256?: string;
};

export type RebuildSmokeResult = {
  name: string;
  ok: boolean;
  detail: string;
};

export type RebuildTypeReport = {
  project: string;
  type: RebuildDataType;
  source_files: string[];
  source_sizes: number[];
  source_sha256: string[];
  lines_read: number;
  structural_validation_ok: boolean;
  error_count: number;
  canonical_records: number;
  search_documents: number;
  embeddings: number;
  index_entries: number;
  old_deleted: boolean;
  success: boolean;
  smoke_ok: boolean;
  /** @deprecated use old_deleted */
  derived_replaced: boolean;
  no_new_folder_structure: boolean;
  smoke: RebuildSmokeResult[];
  steps_completed: RebuildStatusStep[];
  at: string;
  duration_ms: number;
  error?: string | null;
  issues_sample?: Array<{
    sourceFile?: string;
    lineNumber?: number;
    error: string;
  }>;
};

export type RebuildRunReport = {
  project: string;
  types: RebuildDataType[];
  results: RebuildTypeReport[];
  at: string;
  duration_ms: number;
};
