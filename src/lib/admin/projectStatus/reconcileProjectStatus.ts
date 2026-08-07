/**
 * Read-only project status reconciliation from on-disk artifacts.
 * Never runs pipelines, OpenAI, converts, or index rebuilds.
 * Never auto-approves (G_approve).
 */
import { existsSync, readdirSync, statSync, readFileSync } from "fs";
import path from "path";
import { execFileSync } from "child_process";
import {
  ensureWritableDir,
  writeGeneratedText,
} from "@/lib/localData/fs";
import {
  assertProjectKey,
  resolveProjectZonePath,
  resolveWritablePath,
} from "@/lib/localData/paths";
import { getLocalDataRoot } from "@/lib/localData/root";
import {
  listExportTypeConfigs,
  type ExportTypeConfig,
} from "@/lib/admin/datenbasis/exportTypeConfig";
import {
  createInitialManifest,
  deriveOverall,
  loadManifest,
  saveManifest,
} from "@/lib/admin/datenbasis/manifestStore";
import {
  DATENBASIS_STEP_IDS,
  type DatenbasisManifest,
  type DatenbasisStepId,
  type DatenbasisStepStatus,
} from "@/lib/admin/datenbasis/types";
import {
  isStage2Done,
  reconcileSetupStage2,
} from "@/lib/admin/datenbasis/projectStructure";

export type UiStatusKind =
  | "erledigt"
  | "teilweise"
  | "laeuft"
  | "offen"
  | "fehler"
  | "widerspruechlich"
  | "gesperrt"
  | "vorgesehen";

export type RunningProcessInfo = {
  name: string;
  detail: string;
  pid_hint?: string;
};

export type ExportTypeArtifactStatus = {
  export_type: string;
  title: string;
  ui_status: UiStatusKind;
  progress_percent: number;
  detail: string;
  steps: Record<
    string,
    {
      status: string;
      evidence: string | null;
    }
  >;
  warnings: string[];
};

export type AnalysisArtifactStatus = {
  domain: string;
  ui_status: UiStatusKind;
  /** Progress denominator: unique code_unit source_keys. */
  total: number | null;
  /** Progress numerator: unique analysed source_keys. */
  done: number | null;
  missing: number | null;
  percent: number | null;
  analysed_unique: number | null;
  total_unique: number | null;
  /** Raw JSONL line counts (may include duplicate source_keys); not progress. */
  raw_analysis_lines: number | null;
  raw_unit_lines: number | null;
  detail: string;
  running: boolean;
  last_checkpoint: string | null;
};

export type ProjectStatusSnapshot = {
  project_id: string;
  project_root: string;
  created_at: string;
  running_processes: RunningProcessInfo[];
  export_types: Record<string, ExportTypeArtifactStatus>;
  canonical_artifacts: Record<string, unknown>;
  analysis_artifacts: Record<string, AnalysisArtifactStatus>;
  index_artifacts: Record<string, unknown>;
  manual_approvals: Record<string, unknown>;
  warnings: string[];
};

export type ReconciledProjectStatus = ProjectStatusSnapshot & {
  reconciled_at: string;
  manifests_updated: string[];
  ui_corrections: string[];
};

function nowIso(): string {
  return new Date().toISOString();
}

function safeCountLines(abs: string, max = 2_000_000): number | null {
  if (!existsSync(abs) || !statSync(abs).isFile()) return null;
  try {
    const text = readFileSync(abs, "utf8");
    let n = 0;
    for (const line of text.split(/\r?\n/)) {
      if (line.trim()) n += 1;
      if (n >= max) break;
    }
    return n;
  } catch {
    return null;
  }
}

function listJsonlInRaw(
  projectKey: string,
  rawFolderParts: string[] | null,
): string[] {
  if (!rawFolderParts?.length) return [];
  const abs = resolveProjectZonePath(projectKey, "raw", ...rawFolderParts);
  if (!existsSync(abs) || !statSync(abs).isDirectory()) return [];
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name.startsWith("_") || name.startsWith(".")) continue;
      const p = path.join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (name.endsWith(".jsonl")) out.push(p);
    }
  };
  walk(abs);
  return out;
}

function canonicalExists(
  projectKey: string,
  relativeOutputs: string[] | null,
): { present: string[]; missing: string[] } {
  const present: string[] = [];
  const missing: string[] = [];
  if (!relativeOutputs?.length) return { present, missing };
  for (const rel of relativeOutputs) {
    // paths like canonical/classes/code_units.jsonl
    const parts = rel.replace(/^canonical\//, "").split("/");
    const abs = resolveProjectZonePath(projectKey, "canonical", ...parts);
    if (existsSync(abs)) present.push(rel);
    else missing.push(rel);
  }
  return { present, missing };
}

function latestValidateLog(
  projectKey: string,
  exportTypeId: string,
): string | null {
  const dir = resolveWritablePath(
    projectKey,
    "logs",
    "datenbasis",
    exportTypeId,
  );
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return null;
  const files = readdirSync(dir)
    .filter((f) => f.startsWith("validate-") && f.endsWith(".json"))
    .sort();
  return files.length ? `logs/datenbasis/${exportTypeId}/${files[files.length - 1]}` : null;
}

function markDone(
  manifest: DatenbasisManifest,
  stepId: DatenbasisStepId,
  evidence: string,
): void {
  const prev = manifest.steps[stepId];
  if (prev.status === "done") return;
  // Never invent approval
  if (stepId === "G_approve") return;
  manifest.steps[stepId] = {
    ...prev,
    status: "done",
    result: {
      summary: `Aus Artefakten rekonstruiert: ${evidence}`,
      ok: true,
      technical: {
        reconciled_from_artifacts: true,
        evidence,
      },
    },
    updated_at: nowIso(),
    confirmed_at: prev.confirmed_at ?? nowIso(),
  };
}

function unlockNextReady(manifest: DatenbasisManifest): void {
  // First non-done step becomes ready (except G_approve → awaiting if F done)
  for (const id of DATENBASIS_STEP_IDS) {
    const s = manifest.steps[id].status;
    if (s === "done") continue;
    if (id === "G_approve") {
      if (manifest.steps.F_rag_test.status === "done") {
        manifest.steps[id] = {
          ...manifest.steps[id],
          status: "awaiting",
          updated_at: nowIso(),
        };
      }
      break;
    }
    if (s === "locked" || s === "ready" || s === "open") {
      manifest.steps[id] = {
        ...manifest.steps[id],
        status: "ready",
        updated_at: nowIso(),
      };
      break;
    }
    break;
  }
}

/** Detect analysis/convert/index workers — display only, never kill. */
export function detectRunningProcesses(): RunningProcessInfo[] {
  const patterns = [
    "analyze-sap-code-units",
    "analyze-classes",
    "run-classes-pipeline",
    "run-programs-fm-pipeline",
    "run-materials-pipeline",
    "run-customers-vendors-pipeline",
    "index-classes-into-hybrid",
    "syncMessageIdoc",
    "message-idoc",
    "convert-message-idoc",
  ];
  const found: RunningProcessInfo[] = [];
  try {
    const out = execFileSync("pgrep", ["-fl", "tsx|node"], {
      encoding: "utf8",
      timeout: 3000,
    });
    for (const line of out.split("\n")) {
      const hit = patterns.find((p) => line.includes(p));
      if (!hit) continue;
      const pid = line.trim().split(/\s+/)[0] ?? "";
      found.push({
        name: hit,
        detail: line.trim().slice(0, 200),
        pid_hint: pid,
      });
    }
  } catch {
    // pgrep exit 1 = no matches — fine
  }
  return found;
}

/** Count unique non-empty source_key values in a JSONL file (streaming). */
function countUniqueSourceKeys(absolute: string): number | null {
  if (!existsSync(absolute)) return null;
  try {
    const keys = new Set<string>();
    const text = readFileSync(absolute, "utf8");
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line) as { source_key?: unknown };
        if (typeof o.source_key === "string" && o.source_key.trim()) {
          keys.add(o.source_key);
        }
      } catch {
        // skip malformed line for status only
      }
    }
    return keys.size;
  } catch {
    return null;
  }
}

function buildClassesAnalysis(
  projectKey: string,
  running: RunningProcessInfo[],
): AnalysisArtifactStatus {
  const unitsAbs = resolveProjectZonePath(
    projectKey,
    "canonical",
    "classes",
    "code_units.jsonl",
  );
  const analysesAbs = resolveProjectZonePath(
    projectKey,
    "analyses",
    "classes",
    "unit_analyses.jsonl",
  );
  const raw_unit_lines = safeCountLines(unitsAbs);
  const raw_analysis_lines = safeCountLines(analysesAbs);
  const total_unique = countUniqueSourceKeys(unitsAbs);
  const analysed_unique = countUniqueSourceKeys(analysesAbs);
  // Progress fields use unique keys only (not raw line counts).
  const total = total_unique;
  const done = analysed_unique;
  const isRunning = running.some((r) =>
    /analyze-sap-code-units|analyze-classes/.test(r.name),
  );
  let ui_status: UiStatusKind = "offen";
  let detail = "Keine Klassenanalyse-Artefakte";
  let percent: number | null = null;
  let missing: number | null = null;
  if (total != null && total > 0 && done != null) {
    missing = Math.max(0, total - done);
    percent = Math.round((done / total) * 100);
    const rawHint =
      raw_analysis_lines != null
        ? ` Rohzeilen Analysen: ${raw_analysis_lines.toLocaleString("de-DE")}.`
        : "";
    if (isRunning) {
      ui_status = "laeuft";
      detail = `Klassenanalyse läuft — ${done.toLocaleString("de-DE")} / ${total.toLocaleString("de-DE")} eindeutige Methoden (${percent} %).${rawHint}`;
    } else if (done >= total) {
      ui_status = "erledigt";
      detail = `Klassenanalyse abgeschlossen — ${done.toLocaleString("de-DE")} / ${total.toLocaleString("de-DE")} eindeutige Methoden.${rawHint}`;
    } else if (done > 0) {
      ui_status = "teilweise";
      detail = `Klassenanalyse: ${done.toLocaleString("de-DE")} / ${total.toLocaleString("de-DE")} eindeutige Methoden (${percent} %).${rawHint}`;
    }
  } else if (done != null && done > 0) {
    ui_status = "teilweise";
    detail = `${done.toLocaleString("de-DE")} eindeutige Analysen vorhanden (Canonical-Gesamtzahl unbekannt).`;
  }

  let last_checkpoint: string | null = null;
  if (existsSync(analysesAbs)) {
    try {
      last_checkpoint = statSync(analysesAbs).mtime.toISOString();
    } catch {
      /* ignore */
    }
  }

  return {
    domain: "classes",
    ui_status,
    total,
    done,
    missing,
    percent,
    analysed_unique,
    total_unique,
    raw_analysis_lines,
    raw_unit_lines,
    detail,
    running: isRunning,
    last_checkpoint,
  };
}

function buildMessageIdocExtras(
  projectKey: string,
): Record<string, unknown> {
  const rawManifestAbs = resolveWritablePath(
    projectKey,
    "logs",
    "message-idoc-config",
    "raw-manifest.json",
  );
  const convertAbs = resolveWritablePath(
    projectKey,
    "logs",
    "message-idoc-config",
    "convert-report.json",
  );
  const indexSyncAbs = resolveWritablePath(
    projectKey,
    "logs",
    "message-idoc-config",
    "index-sync.json",
  );
  const objectsAbs = resolveProjectZonePath(
    projectKey,
    "canonical",
    "message-idoc-config",
    "objects.jsonl",
  );
  const relationsAbs = resolveProjectZonePath(
    projectKey,
    "canonical",
    "message-idoc-config",
    "relations.jsonl",
  );
  const evalAbs = resolveWritablePath(
    projectKey,
    "logs",
    "evaluation",
    "zecd",
    "evaluation-report.json",
  );

  let rawGroups: unknown = null;
  if (existsSync(rawManifestAbs)) {
    try {
      const m = JSON.parse(readFileSync(rawManifestAbs, "utf8"));
      rawGroups = {
        detected: m.detected_groups?.length ?? null,
        expected: m.expected_groups?.length ?? 10,
        status: m.status ?? null,
      };
    } catch {
      rawGroups = { error: "raw-manifest unreadable" };
    }
  }

  return {
    raw_manifest: existsSync(rawManifestAbs),
    raw_groups: rawGroups,
    convert_report: existsSync(convertAbs),
    index_sync: existsSync(indexSyncAbs),
    canonical_objects: safeCountLines(objectsAbs),
    canonical_relations: safeCountLines(relationsAbs),
    zecd_eval_present: existsSync(evalAbs),
  };
}

function reconcileOneExportType(
  projectKey: string,
  cfg: ExportTypeConfig,
  unlocked: boolean,
  corrections: string[],
  warnings: string[],
  writeManifests: boolean,
): { status: ExportTypeArtifactStatus; updated: boolean } {
  const rawFiles = listJsonlInRaw(projectKey, cfg.rawFolderParts);
  const validateLog = latestValidateLog(projectKey, cfg.id);
  const canon = canonicalExists(projectKey, cfg.canonicalOutputs);
  // message-idoc uses folder presence even if config still says "geplant"
  const msgidocCanonDir = resolveProjectZonePath(
    projectKey,
    "canonical",
    "message-idoc-config",
  );
  const msgidocCanonOk =
    cfg.id === "message-idoc-config" &&
    existsSync(msgidocCanonDir) &&
    existsSync(path.join(msgidocCanonDir, "objects.jsonl"));

  let manifest = loadManifest(projectKey, cfg.id);
  const hadManifest = Boolean(manifest);
  if (!manifest) {
    manifest = createInitialManifest(projectKey, cfg, unlocked);
  } else {
    manifest = { ...manifest, unlocked, order_index: cfg.orderIndex };
  }

  const stepsEvidence: ExportTypeArtifactStatus["steps"] = {};
  const typeWarnings: string[] = [];
  let updated = false;

  // A + B from RAW — oder Folgeartefakte ohne RAW (nicht auf 0 % zurücksetzen)
  if (rawFiles.length > 0) {
    if (manifest.steps.A_sap_export.status !== "done") {
      markDone(manifest, "A_sap_export", `${rawFiles.length} RAW-Datei(en)`);
      updated = true;
      corrections.push(
        `${cfg.id}: A_sap_export → done (RAW ${rawFiles.length})`,
      );
    }
    if (manifest.steps.B_raw_detect.status !== "done") {
      markDone(
        manifest,
        "B_raw_detect",
        `RAW erkannt unter ${cfg.rawFolder ?? "raw/…"}`,
      );
      updated = true;
      corrections.push(`${cfg.id}: B_raw_detect → done`);
    }
    stepsEvidence.A_sap_export = {
      status: "done",
      evidence: `${rawFiles.length} Dateien`,
    };
    stepsEvidence.B_raw_detect = {
      status: "done",
      evidence: cfg.rawFolder,
    };
  } else {
    const followOnPresent =
      msgidocCanonOk ||
      canon.present.length > 0 ||
      manifest.steps.D_convert.status === "done" ||
      manifest.steps.C_validate.status === "done";
    if (followOnPresent) {
      const note =
        "RAW-Quelle derzeit nicht vorhanden, Folgeartefakte vorhanden";
      if (manifest.steps.A_sap_export.status !== "done") {
        markDone(manifest, "A_sap_export", note);
        updated = true;
        corrections.push(`${cfg.id}: A_sap_export → done (${note})`);
      }
      // B bleibt informativ „offen/Hinweis“, nicht Fehler — Convert nicht sperren
      if (
        manifest.steps.B_raw_detect.status === "error" ||
        manifest.steps.B_raw_detect.status === "locked"
      ) {
        manifest.steps.B_raw_detect = {
          ...manifest.steps.B_raw_detect,
          status: "ready",
          result: {
            summary: note,
            ok: true,
            technical: { reconciled_from_artifacts: true, evidence: note },
          },
          updated_at: nowIso(),
        };
        updated = true;
        corrections.push(`${cfg.id}: B_raw_detect → ready (${note})`);
      }
      stepsEvidence.A_sap_export = { status: "done", evidence: note };
      stepsEvidence.B_raw_detect = { status: "teilweise", evidence: note };
      typeWarnings.push(note);
      warnings.push(`${cfg.id}: ${note}`);
    } else {
      stepsEvidence.A_sap_export = { status: "offen", evidence: null };
      stepsEvidence.B_raw_detect = { status: "offen", evidence: null };
      if (cfg.rawFolderParts) {
        typeWarnings.push(`Kein RAW unter ${cfg.rawFolder}`);
      }
    }
  }

  // C validation
  if (validateLog) {
    if (manifest.steps.C_validate.status !== "done") {
      markDone(manifest, "C_validate", validateLog);
      updated = true;
      corrections.push(`${cfg.id}: C_validate → done (${validateLog})`);
    }
    stepsEvidence.C_validate = { status: "done", evidence: validateLog };
  } else if (rawFiles.length > 0) {
    stepsEvidence.C_validate = {
      status: "offen",
      evidence: null,
    };
    typeWarnings.push("RAW vorhanden, Validation-Manifest fehlt");
    warnings.push(`${cfg.id}: RAW erkannt, Validierung offen`);
  } else {
    stepsEvidence.C_validate = { status: "offen", evidence: null };
  }

  // D convert
  const converted =
    msgidocCanonOk ||
    (canon.present.length > 0 &&
      (cfg.canonicalOutputs == null ||
        canon.present.length >= Math.min(2, cfg.canonicalOutputs.length)));
  if (converted) {
    if (manifest.steps.D_convert.status !== "done") {
      markDone(
        manifest,
        "D_convert",
        msgidocCanonOk
          ? "canonical/message-idoc-config/objects.jsonl"
          : canon.present.join(", "),
      );
      updated = true;
      corrections.push(`${cfg.id}: D_convert → done`);
    }
    stepsEvidence.D_convert = {
      status: "done",
      evidence: msgidocCanonOk
        ? "canonical/message-idoc-config"
        : canon.present.slice(0, 3).join(", "),
    };
    if (canon.missing.length && !msgidocCanonOk) {
      typeWarnings.push(
        `Canonical teilweise: fehlend ${canon.missing.slice(0, 3).join(", ")}`,
      );
    }
  } else if (rawFiles.length > 0 && validateLog) {
    stepsEvidence.D_convert = { status: "offen", evidence: null };
    typeWarnings.push("Validiert, aber Canonical fehlt");
  } else {
    stepsEvidence.D_convert = { status: "offen", evidence: null };
  }

  // E / F — only if artifacts exist (do not invent)
  const testQ = resolveWritablePath(
    projectKey,
    "logs",
    "datenbasis",
    cfg.id,
    "test-questions.json",
  );
  if (existsSync(testQ) && manifest.steps.E_test_questions.status !== "done") {
    markDone(manifest, "E_test_questions", "logs/.../test-questions.json");
    updated = true;
  }
  stepsEvidence.E_test_questions = {
    status: manifest.steps.E_test_questions.status,
    evidence: existsSync(testQ) ? "test-questions.json" : null,
  };

  const ragTest = resolveWritablePath(
    projectKey,
    "logs",
    "datenbasis",
    cfg.id,
    "rag-test.json",
  );
  const zecdEval =
    cfg.id === "message-idoc-config" &&
    existsSync(
      resolveWritablePath(
        projectKey,
        "logs",
        "evaluation",
        "zecd",
        "evaluation-report.json",
      ),
    );
  if (
    (existsSync(ragTest) || zecdEval) &&
    manifest.steps.F_rag_test.status !== "done"
  ) {
    markDone(
      manifest,
      "F_rag_test",
      zecdEval ? "logs/evaluation/zecd/evaluation-report.json" : "rag-test.json",
    );
    updated = true;
    corrections.push(`${cfg.id}: F_rag_test → done`);
  }
  stepsEvidence.F_rag_test = {
    status: manifest.steps.F_rag_test.status,
    evidence: existsSync(ragTest) || zecdEval ? "testlauf vorhanden" : null,
  };

  // G — never auto
  const approved = manifest.steps.G_approve.status === "done";
  stepsEvidence.G_approve = {
    status: approved ? "done" : "manuell",
    evidence: approved ? "manuelle Freigabe vorhanden" : null,
  };
  if (!approved && converted) {
    typeWarnings.push("Canonical vorhanden — manuelle Freigabe fehlt");
  }

  if (unlocked) {
    unlockNextReady(manifest);
    if (
      cfg.implementation === "prepared" &&
      (converted || rawFiles.length > 0)
    ) {
      manifest.overall = approved ? "approved" : "in_progress";
    } else if (cfg.implementation === "full") {
      manifest.overall = deriveOverall(manifest.steps, true, "full");
    } else {
      manifest.overall = deriveOverall(
        manifest.steps,
        true,
        cfg.implementation,
      );
    }
  } else {
    // Keep locked overall but still record evidence for UI honesty
    if (!hadManifest && (rawFiles.length > 0 || converted)) {
      warnings.push(
        `${cfg.id}: Artefakte vorhanden, Typ in UI noch gesperrt (Unlock-Kette)`,
      );
    }
  }

  const unlockedBefore = hadManifest ? loadManifest(projectKey, cfg.id)?.unlocked : false;
  const shouldPersist =
    writeManifests &&
    (updated ||
      !hadManifest ||
      unlockedBefore !== unlocked ||
      (unlocked && manifest.overall !== "locked" && hadManifest));

  if (shouldPersist) {
    // Persist status metadata only (never RAW/canonical/index content)
    saveManifest(projectKey, manifest);
    updated = true;
  } else if (!writeManifests) {
    updated = false;
  }

  const doneCount = DATENBASIS_STEP_IDS.filter(
    (id) => manifest.steps[id].status === "done",
  ).length;
  let progress = Math.round((doneCount / DATENBASIS_STEP_IDS.length) * 100);
  if (approved) progress = 100;

  let ui_status: UiStatusKind = "offen";
  if (!unlocked && !converted && rawFiles.length === 0) ui_status = "gesperrt";
  else if (approved) ui_status = "erledigt";
  else if (typeWarnings.some((w) => /widersprüch|fehlt|teilweise/i.test(w))) {
    ui_status =
      converted || rawFiles.length ? "teilweise" : "widerspruechlich";
  } else if (doneCount > 0 && doneCount < DATENBASIS_STEP_IDS.length) {
    ui_status = "teilweise";
  } else if (doneCount === 0 && (rawFiles.length > 0 || converted)) {
    ui_status = "widerspruechlich";
    typeWarnings.push("Artefakte vorhanden, Manifest-Status war 0 %");
  }

  const detailParts = [
    rawFiles.length ? `RAW ${rawFiles.length}` : null,
    validateLog ? "validiert" : null,
    converted ? "konvertiert" : null,
    approved ? "freigegeben" : "Freigabe offen",
  ].filter(Boolean);

  return {
    status: {
      export_type: cfg.id,
      title: cfg.title,
      ui_status,
      progress_percent: unlocked || converted || rawFiles.length ? progress : 0,
      detail: detailParts.join(" · ") || "Keine Artefakte",
      steps: stepsEvidence,
      warnings: typeWarnings,
    },
    updated,
  };
}

/**
 * Full read-only snapshot + optional manifest status repair.
 */
export function reconcileProjectStatus(params: {
  projectKey: string;
  projectId?: string;
  /** Persist repaired datenbasis manifests (status only). Default true. */
  writeManifests?: boolean;
}): ReconciledProjectStatus {
  const projectKey = assertProjectKey(params.projectKey);
  getLocalDataRoot();
  const projectRoot = path.join(
    process.env.LOCAL_DATA_ROOT?.trim() || "",
    projectKey,
  );
  const created_at = nowIso();
  const running_processes = detectRunningProcesses();
  const warnings: string[] = [];
  const corrections: string[] = [];
  const manifests_updated: string[] = [];

  const stage2 = reconcileSetupStage2(projectKey);
  const stage2Done = isStage2Done(stage2);
  const foldersOk = Boolean(stage2.folders_ok);
  // Artifact sync may unlock types for status display when folders exist,
  // even if Stage-2 manual confirmation is still pending.
  const unlockBase = stage2Done || foldersOk;
  if (!stage2Done && foldersOk) {
    warnings.push(
      "Stufe 2: Ordner vorhanden, manuelle Bestätigung noch offen — Fortschritt aus Artefakten trotzdem rekonstruiert.",
    );
  }

  // Unlock map without forcing prepared→locked forever when artifacts exist
  const unlocks: Record<string, boolean> = {};
  {
    const configs = listExportTypeConfigs();
    let priorApproved = true;
    for (const cfg of configs) {
      if (!unlockBase) {
        unlocks[cfg.id] = false;
        continue;
      }
      if (cfg.unlockIndependent) {
        unlocks[cfg.id] =
          cfg.implementation === "full" || cfg.implementation === "prepared";
        continue;
      }
      if (cfg.implementation === "locked") {
        unlocks[cfg.id] = false;
        continue;
      }
      if (cfg.orderIndex === 0) {
        unlocks[cfg.id] = true;
        const m = loadManifest(projectKey, cfg.id);
        priorApproved = m?.overall === "approved";
        continue;
      }
      if (cfg.implementation === "full" || cfg.implementation === "prepared") {
        // For status reconstruction: unlock when prior approved OR prior has convert artifacts
        const priorCfg = configs.find((c) => c.orderIndex === cfg.orderIndex - 1);
        const priorManifest = priorCfg
          ? loadManifest(projectKey, priorCfg.id)
          : null;
        const priorConverted =
          priorManifest?.steps.D_convert.status === "done" ||
          priorManifest?.overall === "approved";
        unlocks[cfg.id] = priorApproved || priorConverted || foldersOk;
        const m = loadManifest(projectKey, cfg.id);
        priorApproved = Boolean(
          unlocks[cfg.id] && m?.overall === "approved",
        );
        continue;
      }
      unlocks[cfg.id] = false;
    }
  }

  const export_types: Record<string, ExportTypeArtifactStatus> = {};
  const write = params.writeManifests !== false;

  for (const cfg of listExportTypeConfigs()) {
    const { status, updated } = reconcileOneExportType(
      projectKey,
      cfg,
      Boolean(unlocks[cfg.id]),
      write ? corrections : [],
      warnings,
      write,
    );
    export_types[cfg.id] = status;
    if (updated && write) manifests_updated.push(cfg.id);
  }

  const analysis_artifacts: Record<string, AnalysisArtifactStatus> = {
    classes: buildClassesAnalysis(projectKey, running_processes),
  };

  const indexManifestAbs = resolveWritablePath(
    projectKey,
    "indexes",
    "search/index_manifest.json",
  );
  const docsAbs = resolveWritablePath(
    projectKey,
    "indexes",
    "search/search_documents.jsonl",
  );
  let index_artifacts: Record<string, unknown> = {
    manifest_present: existsSync(indexManifestAbs),
    documents_present: existsSync(docsAbs),
  };
  if (existsSync(indexManifestAbs) && !existsSync(docsAbs)) {
    index_artifacts = {
      ...index_artifacts,
      ui_status: "widerspruechlich",
      detail: "Indexmanifest vorhanden, search_documents.jsonl fehlt",
    };
    warnings.push("Index widersprüchlich: Manifest ohne Dokumentdatei");
  } else if (existsSync(indexManifestAbs)) {
    try {
      const im = JSON.parse(readFileSync(indexManifestAbs, "utf8"));
      index_artifacts = {
        ...index_artifacts,
        ui_status: "erledigt",
        document_count: im.document_count ?? null,
        embedding_count: im.embedding_count ?? null,
        at: im.at ?? null,
      };
    } catch {
      index_artifacts = {
        ...index_artifacts,
        ui_status: "widerspruechlich",
        detail: "Indexmanifest nicht lesbar",
      };
    }
  } else {
    index_artifacts = { ...index_artifacts, ui_status: "offen" };
  }

  const canonical_artifacts: Record<string, unknown> = {
    message_idoc: buildMessageIdocExtras(projectKey),
  };
  for (const folder of [
    "classes",
    "programs",
    "function-modules",
    "control-tables",
  ] as const) {
    const abs = resolveProjectZonePath(projectKey, "canonical", folder);
    canonical_artifacts[folder] = {
      present: existsSync(abs),
      ingest_report: existsSync(path.join(abs, "ingest_report.json")),
    };
  }

  const manual_approvals: Record<string, unknown> = {};
  for (const cfg of listExportTypeConfigs()) {
    const m = loadManifest(projectKey, cfg.id);
    manual_approvals[cfg.id] = {
      approved: m?.steps.G_approve.status === "done",
      approved_at: m?.steps.G_approve.approved_at ?? null,
    };
  }

  const snapshot: ProjectStatusSnapshot = {
    project_id: params.projectId ?? projectKey,
    project_root: projectRoot,
    created_at,
    running_processes,
    export_types,
    canonical_artifacts,
    analysis_artifacts,
    index_artifacts,
    manual_approvals,
    warnings,
  };

  ensureWritableDir(projectKey, "logs", "project-status");
  const ts = created_at.replace(/[:.]/g, "-");
  writeGeneratedText(
    projectKey,
    "logs",
    `project-status/status-snapshot-${ts}.json`,
    `${JSON.stringify(snapshot, null, 2)}\n`,
  );

  const reconciled: ReconciledProjectStatus = {
    ...snapshot,
    reconciled_at: nowIso(),
    manifests_updated,
    ui_corrections: corrections,
  };
  writeGeneratedText(
    projectKey,
    "logs",
    "project-status/reconciled-status.json",
    `${JSON.stringify(reconciled, null, 2)}\n`,
  );

  return reconciled;
}
