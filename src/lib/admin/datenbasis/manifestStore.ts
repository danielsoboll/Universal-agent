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

export function createInitialManifest(
  projectKey: string,
  cfg: ExportTypeConfig,
  unlocked: boolean,
): DatenbasisManifest {
  const steps = {} as Record<DatenbasisStepId, DatenbasisStepState>;
  for (const id of DATENBASIS_STEP_IDS) {
    let status: DatenbasisStepStatus = "locked";
    if (unlocked && cfg.implementation === "full") {
      status = id === "A_sap_export" ? "ready" : "locked";
    } else if (unlocked && cfg.implementation === "prepared") {
      // prepared: show as locked pipeline until rules verified
      status = "locked";
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
        : "locked"
      : "locked",
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
  if (!unlocked || implementation === "locked") return "locked";
  if (implementation === "prepared") return "locked";
  if (steps.G_approve.status === "done") return "approved";
  if (
    DATENBASIS_STEP_IDS.some((id) => steps[id].status === "error")
  ) {
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
    if (
      steps.A_sap_export.status === "ready" &&
      DATENBASIS_STEP_IDS.every(
        (id) =>
          id === "A_sap_export" ||
          steps[id].status === "locked",
      )
    ) {
      return "not_started";
    }
    return "in_progress";
  }
  return "not_started";
}

/** After a successful step, unlock the next; reset following on failure. */
export function advanceAfterSuccess(
  manifest: DatenbasisManifest,
  completedId: DatenbasisStepId,
): DatenbasisManifest {
  const idx = DATENBASIS_STEP_IDS.indexOf(completedId);
  const steps = { ...manifest.steps };
  steps[completedId] = {
    ...steps[completedId],
    status: "done",
    updated_at: nowIso(),
  };
  const nextId = DATENBASIS_STEP_IDS[idx + 1];
  if (nextId) {
    steps[nextId] = {
      ...steps[nextId],
      status: nextId === "G_approve" ? "awaiting" : "ready",
      updated_at: nowIso(),
    };
    // lock anything after next
    for (let i = idx + 2; i < DATENBASIS_STEP_IDS.length; i++) {
      const id = DATENBASIS_STEP_IDS[i]!;
      steps[id] = {
        ...emptyStep(id, "locked"),
      };
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
  const steps = { ...manifest.steps };
  steps[stepId] = {
    ...steps[stepId],
    status: "error",
    result,
    updated_at: nowIso(),
  };
  // lock following
  const idx = DATENBASIS_STEP_IDS.indexOf(stepId);
  for (let i = idx + 1; i < DATENBASIS_STEP_IDS.length; i++) {
    const id = DATENBASIS_STEP_IDS[i]!;
    steps[id] = emptyStep(id, "locked");
  }
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
    };
    if (!unlocked) {
      manifest.overall = "locked";
      for (const id of DATENBASIS_STEP_IDS) {
        manifest.steps[id] = {
          ...manifest.steps[id],
          status: "locked",
        };
      }
    } else if (
      cfg.implementation === "full" &&
      manifest.overall === "locked"
    ) {
      // freshly unlocked
      if (
        DATENBASIS_STEP_IDS.every(
          (id) =>
            manifest!.steps[id].status === "locked" ||
            !manifest!.steps[id].updated_at,
        )
      ) {
        manifest = createInitialManifest(key, cfg, true);
      } else {
        manifest.overall = deriveOverall(
          manifest.steps,
          true,
          cfg.implementation,
        );
      }
    } else if (cfg.implementation !== "full") {
      manifest.overall = "locked";
    } else {
      manifest.overall = deriveOverall(
        manifest.steps,
        true,
        cfg.implementation,
      );
    }
  }

  saveManifest(key, manifest);
  return manifest;
}

export function nextActionLabel(manifest: DatenbasisManifest): {
  stepId: DatenbasisStepId | null;
  label: string;
} {
  if (!manifest.unlocked || manifest.overall === "locked") {
    return { stepId: null, label: "Gesperrt" };
  }
  if (manifest.overall === "approved") {
    return { stepId: null, label: "Freigegeben" };
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
  if (!manifest.unlocked) return 0;
  if (manifest.overall === "approved") return 100;
  const done = DATENBASIS_STEP_IDS.filter(
    (id) => manifest.steps[id].status === "done",
  ).length;
  return Math.round((done / DATENBASIS_STEP_IDS.length) * 100);
}
