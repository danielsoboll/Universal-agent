import { listExportTypeConfigs } from "@/lib/admin/datenbasis/exportTypeConfig";
import {
  computeUnlockMap,
  nextActionLabel,
  progressPercent,
  reconcileManifest,
} from "@/lib/admin/datenbasis/manifestStore";
import {
  isStage2Done,
  reconcileSetupStage2,
} from "@/lib/admin/datenbasis/projectStructure";
import type {
  DatenbasisOverview,
  DatenbasisTypeCard,
} from "@/lib/admin/datenbasis/types";
import { getLocalDataRoot } from "@/lib/localData/root";

export function computeDatenbasisOverview(params: {
  projectKey: string;
  customerId?: string | null;
}): DatenbasisOverview {
  const projectKey = params.projectKey.trim() || "P01";
  let localDataError: string | null = null;
  let stage2Done = false;

  try {
    getLocalDataRoot();
    const stage2 = reconcileSetupStage2(projectKey);
    stage2Done = isStage2Done(stage2);
  } catch (e) {
    localDataError =
      e instanceof Error ? e.message : "LOCAL_DATA_ROOT nicht verfügbar";
  }

  const unlocks = localDataError
    ? {}
    : computeUnlockMap(projectKey, stage2Done);

  const qs = params.customerId
    ? `?customer=${encodeURIComponent(params.customerId)}`
    : "";

  const types: DatenbasisTypeCard[] = [];
  for (const cfg of listExportTypeConfigs()) {
    const unlocked = Boolean(unlocks[cfg.id]);
    const manifest = localDataError
      ? null
      : reconcileManifest(projectKey, cfg.id, unlocked);

    const overall = manifest?.overall ?? "not_started";
    const next = manifest
      ? nextActionLabel(manifest)
      : { stepId: null, label: "Noch nicht gestartet" };
    const progress = manifest ? progressPercent(manifest) : 0;

    // Prefer explainable next.label (e.g. "Canonical bereit …") whenever
    // there is real pipeline progress — never overwrite with unlock fluff.
    let nextActionLabelText = next.label;
    if (cfg.implementation === "locked") {
      nextActionLabelText = "Scaffold — Regeln ausstehend";
    } else if (progress > 0 || (next.label && next.label !== "—")) {
      nextActionLabelText = next.label;
    } else if (cfg.implementation === "prepared" && unlocked) {
      nextActionLabelText = "Vorbereitet (CT-Fahrplan separat)";
    } else if (!unlocked) {
      nextActionLabelText = stage2Done
        ? cfg.unlockIndependent
          ? "Noch nicht gestartet — Stufe 2 prüfen"
          : "Noch nicht gestartet — vorherigen Typ freigeben"
        : "Noch nicht gestartet — Stufe 2 abschließen";
    }

    types.push({
      id: cfg.id,
      title: cfg.title,
      description: cfg.description,
      orderIndex: cfg.orderIndex,
      implementation: cfg.implementation,
      certainty: cfg.certainty,
      unlocked,
      overall,
      progressPercent: progress,
      nextStepId: next.stepId,
      nextActionLabel: nextActionLabelText,
      href: `/admin/steps/3/${cfg.id}${qs}`,
      sapReport: cfg.sapReport,
      rawFolder: cfg.rawFolder,
    });
  }

  const tracked = types.filter(
    (t) => t.implementation === "full" || t.implementation === "prepared",
  );
  const classes = types.find((t) => t.id === "classes");
  const area3Done = classes?.overall === "approved";
  const doneCount = types.filter((t) => t.overall === "approved").length;
  const progressPercentVal = area3Done
    ? 100
    : classes
      ? classes.progressPercent
      : 0;

  return {
    projectKey,
    types,
    doneCount,
    totalCount: tracked.length,
    progressPercent: progressPercentVal,
    area3Done,
    localDataError,
  };
}
