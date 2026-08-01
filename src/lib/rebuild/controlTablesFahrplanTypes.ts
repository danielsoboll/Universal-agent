/** Linear Admin Fahrplan for control-tables data import (project-scoped). */

export const CONTROL_TABLES_FAHRPLAN_TYPE = "control-tables" as const;

export const FAHRPLAN_STEP_IDS = [1, 2, 3, 4, 5, 6] as const;
export type FahrplanStepId = (typeof FAHRPLAN_STEP_IDS)[number];

/** Internal step status — never set by a manual checkbox. */
export type FahrplanStepStatus =
  | "not_available"
  | "ready"
  | "running"
  | "failed"
  | "success";

export const FAHRPLAN_STEP_STATUS_LABELS_DE: Record<FahrplanStepStatus, string> =
  {
    not_available: "Gesperrt",
    ready: "Bereit",
    running: "Läuft",
    failed: "Fehler",
    success: "OK",
  };

export const FAHRPLAN_STEP_META: Record<
  FahrplanStepId,
  {
    title: string;
    shortTitle: string;
    description: string;
    actionLabel: string;
    /** Dashboard / „nächste Aktion“ — technical, not PM. */
    nextActionLabel: string;
  }
> = {
  1: {
    title: "Quelldatei erkennen",
    shortTitle: "Quelle",
    description:
      "Prüft raw/control-tables/definitions/ und contents/ auf lesbare Quelldateien",
    actionLabel: "Quelle prüfen",
    nextActionLabel: "Z-/Y-Tabellen: Quelldateien erkennen",
  },
  2: {
    title: "RAW prüfen",
    shortTitle: "RAW",
    description:
      "Validiert JSONL technisch (Pflichtfelder, system_id, Kompatibilität)",
    actionLabel: "RAW prüfen",
    nextActionLabel: "Z-/Y-Tabellen: RAW-Dateien prüfen",
  },
  3: {
    title: "Daten konvertieren",
    shortTitle: "Konvertieren",
    description:
      "Wandelt RAW-JSONL in Canonical-Staging um (Aktivierung erst nach Schritt 4)",
    actionLabel: "Verarbeiten",
    nextActionLabel: "Z-/Y-Tabellen: Daten konvertieren",
  },
  4: {
    title: "Konvertierte Daten prüfen",
    shortTitle: "Prüfen",
    description: "Validiert Canonical-Staging vor der Wissensaktualisierung",
    actionLabel: "Ergebnis prüfen",
    nextActionLabel: "Z-/Y-Tabellen: Konvertierte Daten prüfen",
  },
  5: {
    title: "Wissensbestand aktualisieren",
    shortTitle: "Wissen",
    description:
      "Ersetzt abgeleitete Control-Table-Daten, SearchDocs, Embeddings und Index",
    actionLabel: "Wissensbestand neu aufbauen",
    nextActionLabel: "Z-/Y-Tabellen: Wissensbestand aktualisieren",
  },
  6: {
    title: "Suche testen",
    shortTitle: "Suche",
    description: "Führt echte Direct-RAG-Smoke-Tests gegen den Index aus",
    actionLabel: "Suche prüfen",
    nextActionLabel: "Z-/Y-Tabellen: Suche prüfen",
  },
};

export type FahrplanOverallStatus =
  | "not_started"
  | "in_review"
  | "processing"
  | "action_required"
  | "completed";

export const FAHRPLAN_OVERALL_LABELS_DE: Record<FahrplanOverallStatus, string> =
  {
    not_started: "Nicht gestartet",
    in_review: "Quellen",
    processing: "Läuft",
    action_required: "Fehler",
    completed: "Fertig",
  };

export type FahrplanSourceFileInfo = {
  relativePath: string;
  fileName: string;
  bytes: number;
  role: "definitions" | "contents";
  system_id?: string | null;
};

export type FahrplanStepResult = {
  summary: string;
  hint?: string;
  files?: FahrplanSourceFileInfo[];
  counts?: Record<string, number>;
  warnings?: string[];
  errors?: string[];
  substeps?: Array<{ key: string; label: string; ok: boolean; detail?: string }>;
  samples?: Array<{ query: string; ok: boolean; detail: string }>;
  technical?: Record<string, unknown>;
};

export type FahrplanStepState = {
  id: FahrplanStepId;
  status: FahrplanStepStatus;
  result: FahrplanStepResult | null;
  updated_at: string | null;
};

export type ControlTablesFahrplanState = {
  schema_version: 1;
  project: string;
  type: typeof CONTROL_TABLES_FAHRPLAN_TYPE;
  overall: FahrplanOverallStatus;
  steps: Record<FahrplanStepId, FahrplanStepState>;
  /** Fingerprint of sources used for successful step 1–2 (invalidated on re-run). */
  source_fingerprint: string | null;
  staging_ready: boolean;
  staging_validated: boolean;
  knowledge_activated_at: string | null;
  updated_at: string;
};

export type FahrplanRunResult = {
  ok: boolean;
  stepId: FahrplanStepId;
  state: ControlTablesFahrplanState;
  message: string;
};

/** Next executable CT step from persisted technical status (never checklist). */
export function getControlTablesNextAction(
  state: ControlTablesFahrplanState,
): {
  stepId: FahrplanStepId | null;
  label: string;
  done: boolean;
} {
  if (state.overall === "completed") {
    return {
      stepId: null,
      label: "Z-/Y-Tabellen: Import abgeschlossen",
      done: true,
    };
  }
  const failed = FAHRPLAN_STEP_IDS.find(
    (id) => state.steps[id].status === "failed",
  );
  if (failed) {
    return {
      stepId: failed,
      label: FAHRPLAN_STEP_META[failed].nextActionLabel,
      done: false,
    };
  }
  const running = FAHRPLAN_STEP_IDS.find(
    (id) => state.steps[id].status === "running",
  );
  if (running) {
    return {
      stepId: running,
      label: FAHRPLAN_STEP_META[running].nextActionLabel,
      done: false,
    };
  }
  const ready = FAHRPLAN_STEP_IDS.find(
    (id) => state.steps[id].status === "ready",
  );
  if (ready) {
    return {
      stepId: ready,
      label: FAHRPLAN_STEP_META[ready].nextActionLabel,
      done: false,
    };
  }
  return {
    stepId: 1,
    label: FAHRPLAN_STEP_META[1].nextActionLabel,
    done: false,
  };
}
