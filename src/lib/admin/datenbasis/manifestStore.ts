/**
 * Persist Datenbasis manifests under logs/datenbasis/{type}-pipeline.json
 */

import { createHash } from "crypto";
import { existsSync, readFileSync } from "fs";
import {
  ensureWritableDir,
  writeGeneratedText,
} from "@/lib/localData/fs";
import { assertProjectKey, resolveWritablePath } from "@/lib/localData/paths";
import { getLocalDataRoot } from "@/lib/localData/root";
import {
  DATENBASIS_STEP_META,
  getExportTypeConfig,
  listExportTypeConfigs,
  type ExportTypeConfig,
} from "@/lib/admin/datenbasis/exportTypeConfig";
import {
  DATENBASIS_STEP_IDS,
  type DatenbasisManifest,
  type DatenbasisOverallStatus,
  type DatenbasisStepId,
  type DatenbasisStepKind,
  type DatenbasisStepState,
  type DatenbasisStepStatus,
} from "@/lib/admin/datenbasis/types";

function nowIso(): string {
  return new Date().toISOString();
}

function stepKind(id: DatenbasisStepId): DatenbasisStepKind {
  return id === "A_sap_export" || id === "G_approve" ? "manual" : "technical";
}

function emptyStep(
  id: DatenbasisStepId,
  status: DatenbasisStepStatus,
): DatenbasisStepState {
  return {
    id,
    kind: stepKind(id),
    status,
    result: null,
    confirmed_at: null,
    approved_at: null,
    updated_at: null,
  };
}

/**
 * Feste Fortschritts-Logik (SSOT, Summe = 100):
 *
 * | Meilenstein                         | %   | Schritte        |
 * |-------------------------------------|-----|-----------------|
 * | Canonical bereit (exportiert+eingelesen) | 40  | A–D             |
 * | Testdaten-Fragen                    | +15 | E               |
 * | Index / Vektoren                    | +30 | F               |
 * | Freigabe                            | +15 | G               |
 *
 * Beispiel: Materialstammdaten konvertiert, noch kein Index → 40 %.
 * Nicht 0 % (Daten sind da) und nicht 100 % (Suche/RAG fehlt noch).
 */
export const DATENBASIS_STEP_WEIGHTS: Record<DatenbasisStepId, number> = {
  A_sap_export: 5,
  B_raw_detect: 10,
  C_validate: 10,
  D_convert: 15,
  E_test_questions: 15,
  F_rag_test: 30,
  G_approve: 15,
};

/** Meilenstein-Prozente — abgeleitet aus den Gewichten, nicht separat pflegen. */
export const DATENBASIS_PROGRESS = {
  CANONICAL_READY_PERCENT:
    DATENBASIS_STEP_WEIGHTS.A_sap_export +
    DATENBASIS_STEP_WEIGHTS.B_raw_detect +
    DATENBASIS_STEP_WEIGHTS.C_validate +
    DATENBASIS_STEP_WEIGHTS.D_convert,
  AFTER_TESTS_PERCENT:
    DATENBASIS_STEP_WEIGHTS.A_sap_export +
    DATENBASIS_STEP_WEIGHTS.B_raw_detect +
    DATENBASIS_STEP_WEIGHTS.C_validate +
    DATENBASIS_STEP_WEIGHTS.D_convert +
    DATENBASIS_STEP_WEIGHTS.E_test_questions,
  AFTER_INDEX_PERCENT:
    DATENBASIS_STEP_WEIGHTS.A_sap_export +
    DATENBASIS_STEP_WEIGHTS.B_raw_detect +
    DATENBASIS_STEP_WEIGHTS.C_validate +
    DATENBASIS_STEP_WEIGHTS.D_convert +
    DATENBASIS_STEP_WEIGHTS.E_test_questions +
    DATENBASIS_STEP_WEIGHTS.F_rag_test,
  APPROVED_PERCENT: 100,
  LABEL_CANONICAL_READY: "Canonical bereit — Index/Vektoren ausstehend",
  LABEL_INDEX_PENDING: "Index/Vektoren ausstehend",
  LABEL_APPROVAL_PENDING: "Freigabe ausstehend",
} as const;

const CANONICAL_STEPS: readonly DatenbasisStepId[] = [
  "A_sap_export",
  "B_raw_detect",
  "C_validate",
  "D_convert",
];

export function isCanonicalReady(manifest: DatenbasisManifest): boolean {
  return CANONICAL_STEPS.every(
    (id) => manifest.steps[id]?.status === "done",
  );
}

export function isIndexReady(manifest: DatenbasisManifest): boolean {
  return manifest.steps.F_rag_test.status === "done";
}

/** Turn sequential "locked" into "open" so each step shows real status. */
export function openIndependentSteps(
  steps: DatenbasisManifest["steps"],
): DatenbasisManifest["steps"] {
  const next = { ...steps };
  for (const id of DATENBASIS_STEP_IDS) {
    if (next[id].status === "locked") {
      next[id] = { ...next[id], status: "open" };
    }
  }
  return next;
}

export function createInitialManifest(
  projectKey: string,
  cfg: ExportTypeConfig,
  unlocked: boolean,
): DatenbasisManifest {
  const steps = {} as Record<DatenbasisStepId, DatenbasisStepState>;
  for (const id of DATENBASIS_STEP_IDS) {
    let status: DatenbasisStepStatus = "open";
    if (!unlocked || cfg.implementation === "locked") {
      status = "open"; // area still visible; overall reflects scaffold
    } else if (cfg.implementation === "prepared") {
      status = "open";
    } else if (cfg.implementation === "full") {
      // All steps independently open — no sequential lock chain
      status = id === "A_sap_export" ? "ready" : "open";
    }
    steps[id] = emptyStep(id, status);
  }

  return {
    schema_version: 1,
    project: projectKey,
    export_type: cfg.id,
    order_index: cfg.orderIndex,
    unlocked,
    overall: unlocked
      ? cfg.implementation === "full"
        ? "not_started"
        : cfg.implementation === "prepared"
          ? "not_started"
          : "not_started"
      : "not_started",
    source_fingerprint: null,
    selected_raw_file: null,
    raw_immutable: true,
    steps,
    updated_at: nowIso(),
  };
}

function manifestRelativePath(exportTypeId: string): string {
  return `datenbasis/${exportTypeId}-pipeline.json`;
}

export function loadManifest(
  projectKey: string,
  exportTypeId: string,
): DatenbasisManifest | null {
  const key = assertProjectKey(projectKey);
  try {
    getLocalDataRoot();
    const abs = resolveWritablePath(
      key,
      "logs",
      manifestRelativePath(exportTypeId),
    );
    if (!existsSync(abs)) return null;
    const raw = JSON.parse(readFileSync(abs, "utf8")) as DatenbasisManifest;
    if (raw?.schema_version !== 1) return null;
    return raw;
  } catch {
    return null;
  }
}

export function saveManifest(
  projectKey: string,
  manifest: DatenbasisManifest,
): void {
  const key = assertProjectKey(projectKey);
  ensureWritableDir(key, "logs", "datenbasis");
  writeGeneratedText(
    key,
    "logs",
    manifestRelativePath(manifest.export_type),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
}

export function fingerprintFiles(
  files: Array<{ relativePath: string; bytes: number }>,
): string {
  const h = createHash("sha256");
  for (const f of [...files].sort((a, b) =>
    a.relativePath.localeCompare(b.relativePath),
  )) {
    h.update(`${f.relativePath}|${f.bytes}\n`);
  }
  return h.digest("hex").slice(0, 24);
}

/** Derive overall from step statuses. */
export function deriveOverall(
  steps: DatenbasisManifest["steps"],
  unlocked: boolean,
  implementation: ExportTypeConfig["implementation"],
): DatenbasisOverallStatus {
  if (implementation === "locked") return "not_started";
  if (!unlocked && implementation === "prepared") return "not_started";
  if (steps.G_approve.status === "done") return "approved";
  if (DATENBASIS_STEP_IDS.some((id) => steps[id].status === "error")) {
    return "failed";
  }
  if (steps.F_rag_test.status === "done") {
    return "awaiting_approval";
  }
  if (
    DATENBASIS_STEP_IDS.some(
      (id) =>
        steps[id].status === "done" ||
        steps[id].status === "running" ||
        steps[id].status === "ready",
    )
  ) {
    const onlyAReady =
      steps.A_sap_export.status === "ready" &&
      DATENBASIS_STEP_IDS.every(
        (id) =>
          id === "A_sap_export" ||
          steps[id].status === "open" ||
          steps[id].status === "locked",
      );
    if (onlyAReady) return "not_started";
    return "in_progress";
  }
  return "not_started";
}

/** After a successful step, keep remaining steps independently open. */
export function advanceAfterSuccess(
  manifest: DatenbasisManifest,
  completedId: DatenbasisStepId,
): DatenbasisManifest {
  const steps = openIndependentSteps({ ...manifest.steps });
  steps[completedId] = {
    ...steps[completedId],
    status: "done",
    updated_at: nowIso(),
  };
  // Next undoned step becomes ready for a clear CTA (others stay open).
  const idx = DATENBASIS_STEP_IDS.indexOf(completedId);
  for (let i = idx + 1; i < DATENBASIS_STEP_IDS.length; i++) {
    const id = DATENBASIS_STEP_IDS[i]!;
    if (steps[id].status === "open" || steps[id].status === "locked") {
      steps[id] = {
        ...steps[id],
        status: id === "G_approve" ? "awaiting" : "ready",
        updated_at: nowIso(),
      };
      break;
    }
  }
  const cfg = getExportTypeConfig(manifest.export_type);
  const overall = deriveOverall(
    steps,
    manifest.unlocked,
    cfg?.implementation ?? "locked",
  );
  return { ...manifest, steps, overall, updated_at: nowIso() };
}

export function markStepError(
  manifest: DatenbasisManifest,
  stepId: DatenbasisStepId,
  result: DatenbasisStepState["result"],
): DatenbasisManifest {
  const steps = openIndependentSteps({ ...manifest.steps });
  steps[stepId] = {
    ...steps[stepId],
    status: "error",
    result,
    updated_at: nowIso(),
  };
  return {
    ...manifest,
    steps,
    overall: "failed",
    updated_at: nowIso(),
  };
}

export function markStepRunning(
  manifest: DatenbasisManifest,
  stepId: DatenbasisStepId,
): DatenbasisManifest {
  const steps = { ...manifest.steps };
  steps[stepId] = {
    ...steps[stepId],
    status: "running",
    updated_at: nowIso(),
  };
  return {
    ...manifest,
    steps,
    overall: "in_progress",
    updated_at: nowIso(),
  };
}

/**
 * Compute unlock flags from ordered configs + approved prior types.
 * classes starts unlocked when Stage 2 done (caller passes stage2Done).
 */
export function computeUnlockMap(
  projectKey: string,
  stage2Done: boolean,
): Record<string, boolean> {
  const configs = listExportTypeConfigs();
  const map: Record<string, boolean> = {};
  let priorApproved = true;

  for (const cfg of configs) {
    if (!stage2Done) {
      map[cfg.id] = false;
      continue;
    }
    if (cfg.implementation === "locked") {
      map[cfg.id] = false;
      continue;
    }
    // Parallel types (e.g. materials) — do not affect sequential approval chain
    if (cfg.unlockIndependent) {
      map[cfg.id] =
        cfg.implementation === "full" || cfg.implementation === "prepared";
      continue;
    }
    // First full/prepared in order unlocks when stage2 done
    if (cfg.orderIndex === 0) {
      map[cfg.id] = true;
      const m = loadManifest(projectKey, cfg.id);
      priorApproved = m?.overall === "approved";
      continue;
    }
    // Next prepared/full unlocks only after previous approved
    if (cfg.implementation === "prepared" || cfg.implementation === "full") {
      map[cfg.id] = priorApproved;
      const m = loadManifest(projectKey, cfg.id);
      if (map[cfg.id] && m?.overall === "approved") {
        priorApproved = true;
      } else if (map[cfg.id]) {
        priorApproved = m?.overall === "approved";
      } else {
        priorApproved = false;
      }
      continue;
    }
    map[cfg.id] = false;
  }
  return map;
}

export function reconcileManifest(
  projectKey: string,
  exportTypeId: string,
  unlocked: boolean,
): DatenbasisManifest {
  const key = assertProjectKey(projectKey);
  const cfg = getExportTypeConfig(exportTypeId);
  if (!cfg) {
    throw new Error(`Unbekannter Exporttyp: ${exportTypeId}`);
  }

  let manifest = loadManifest(key, exportTypeId);
  if (!manifest) {
    manifest = createInitialManifest(key, cfg, unlocked);
  } else {
    manifest = {
      ...manifest,
      unlocked,
      order_index: cfg.orderIndex,
      steps: openIndependentSteps(manifest.steps),
    };
    if (cfg.implementation === "full" || cfg.implementation === "prepared") {
      manifest.overall = deriveOverall(
        manifest.steps,
        unlocked,
        cfg.implementation,
      );
    } else {
      manifest.overall = "not_started";
    }
  }

  saveManifest(key, manifest);
  return manifest;
}

export function nextActionLabel(manifest: DatenbasisManifest): {
  stepId: DatenbasisStepId | null;
  label: string;
} {
  if (manifest.overall === "approved") {
    return { stepId: null, label: "Freigegeben" };
  }
  const doneCount = DATENBASIS_STEP_IDS.filter(
    (id) => manifest.steps[id].status === "done",
  ).length;
  const testsDone = manifest.steps.E_test_questions.status === "done";
  const indexDone = isIndexReady(manifest);

  if (!manifest.unlocked && doneCount === 0) {
    return { stepId: null, label: "Bereich noch nicht gestartet" };
  }

  // Feste Phasen-Labels nach Meilenstein (nicht generische Step-Verben)
  if (isCanonicalReady(manifest) && !indexDone) {
    if (!testsDone) {
      return {
        stepId: "E_test_questions",
        label: DATENBASIS_PROGRESS.LABEL_CANONICAL_READY,
      };
    }
    return {
      stepId: "F_rag_test",
      label: DATENBASIS_PROGRESS.LABEL_INDEX_PENDING,
    };
  }
  if (indexDone && manifest.steps.G_approve.status !== "done") {
    return {
      stepId: "G_approve",
      label: DATENBASIS_PROGRESS.LABEL_APPROVAL_PENDING,
    };
  }

  const failed = DATENBASIS_STEP_IDS.find(
    (id) => manifest.steps[id].status === "error",
  );
  if (failed) {
    const meta = DATENBASIS_STEP_META[failed];
    return { stepId: failed, label: meta?.actionLabel ?? failed };
  }
  const ready = DATENBASIS_STEP_IDS.find((id) => {
    const s = manifest.steps[id].status;
    return s === "ready" || s === "awaiting" || s === "open";
  });
  if (ready) {
    const meta = DATENBASIS_STEP_META[ready];
    return { stepId: ready, label: meta?.actionLabel ?? ready };
  }
  return { stepId: null, label: "—" };
}

export function progressPercent(manifest: DatenbasisManifest): number {
  if (manifest.overall === "approved") {
    return DATENBASIS_PROGRESS.APPROVED_PERCENT;
  }
  if (
    DATENBASIS_STEP_IDS.every(
      (id) =>
        manifest.steps[id].status !== "done" &&
        manifest.steps[id].status !== "running",
    )
  ) {
    return 0;
  }
  let score = 0;
  for (const id of DATENBASIS_STEP_IDS) {
    if (manifest.steps[id].status === "done") {
      score += DATENBASIS_STEP_WEIGHTS[id];
    }
  }
  return Math.min(100, Math.round(score));
}
