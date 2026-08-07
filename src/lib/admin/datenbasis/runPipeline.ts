/**
 * Run Datenbasis pipeline steps for an export type.
 * Classes and master-data domains (materials/customers/vendors) run independently;
 * they never overwrite each other's artifacts.
 */

import {
  buildClassesTestQuestions,
  convertClasses,
  detectClassesRaw,
  runClassesRagTest,
  validateClassesJsonl,
} from "@/lib/admin/datenbasis/classesPipeline";
import {
  buildCustomersTestQuestions,
  convertCustomers,
  detectCustomersRaw,
  runCustomersRagTestSkipped,
  validateCustomersJsonl,
} from "@/lib/admin/datenbasis/customersPipeline";
import {
  buildFunctionModulesTestQuestions,
  convertFunctionModules,
  detectFunctionModulesRaw,
  runFunctionModulesRagTestSkipped,
  validateFunctionModulesJsonl,
} from "@/lib/admin/datenbasis/functionModulesPipeline";
import {
  buildMaterialsTestQuestions,
  convertMaterials,
  detectMaterialsRaw,
  runMaterialsRagTestSkipped,
  validateMaterialsJsonl,
} from "@/lib/admin/datenbasis/materialsPipeline";
import {
  buildProgramsTestQuestions,
  convertPrograms,
  detectProgramsRaw,
  runProgramsRagTestSkipped,
  validateProgramsJsonl,
} from "@/lib/admin/datenbasis/programsPipeline";
import {
  buildVendorsTestQuestions,
  convertVendors,
  detectVendorsRaw,
  runVendorsRagTestSkipped,
  validateVendorsJsonl,
} from "@/lib/admin/datenbasis/vendorsPipeline";
import { getExportTypeConfig } from "@/lib/admin/datenbasis/exportTypeConfig";
import {
  advanceAfterSuccess,
  loadManifest,
  markStepError,
  markStepRunning,
  reconcileManifest,
  saveManifest,
} from "@/lib/admin/datenbasis/manifestStore";
import { isStage2Done, reconcileSetupStage2 } from "@/lib/admin/datenbasis/projectStructure";
import { computeUnlockMap } from "@/lib/admin/datenbasis/manifestStore";
import type {
  DatenbasisManifest,
  DatenbasisStepId,
  DatenbasisStepResult,
} from "@/lib/admin/datenbasis/types";

export type RunStepParams = {
  projectKey: string;
  exportTypeId: string;
  stepId: DatenbasisStepId;
  /** For B when multiple files */
  selectedRawFile?: string | null;
  /** Manual confirm for A / G */
  confirm?: boolean;
};

export type RunStepResult = {
  ok: boolean;
  message: string;
  manifest: DatenbasisManifest;
};

function nowIso(): string {
  return new Date().toISOString();
}

function ensureReady(
  manifest: DatenbasisManifest,
  stepId: DatenbasisStepId,
): string | null {
  if (!manifest.unlocked) {
    return "Exporttyp noch nicht gestartet (Stufe 2 / Freischaltung)";
  }
  const st = manifest.steps[stepId]?.status;
  if (st !== "ready" && st !== "awaiting" && st !== "error" && st !== "open") {
    if (st === "done") return "Schritt bereits erledigt";
    if (st === "locked") {
      // Legacy manifests — treat as independently runnable
      return null;
    }
    return `Schritt nicht bereit (Status: ${st})`;
  }
  // Steps are independent per area — no sequential lock gate.
  return null;
}

type TechnicalHandlers = {
  detect: (
    projectKey: string,
    selected: string | null | undefined,
  ) => Promise<{
    ok: boolean;
    result: DatenbasisStepResult;
    selected: { fileName: string; bytes: number } | null;
  }>;
  validate: (
    projectKey: string,
    fileName: string,
  ) => Promise<{ ok: boolean; result: DatenbasisStepResult }>;
  convert: (
    projectKey: string,
    fileName: string,
  ) => Promise<{ ok: boolean; result: DatenbasisStepResult }> | {
    ok: boolean;
    result: DatenbasisStepResult;
  };
  testQuestions: (projectKey: string) => {
    ok: boolean;
    result: DatenbasisStepResult;
  };
  ragTest: (
    projectKey: string,
    questions: string[],
  ) => Promise<{ ok: boolean; result: DatenbasisStepResult }>;
  approveSummary: string;
  approveMessage: string;
  sapConfirmSummary: string;
};

function handlersFor(exportTypeId: string): TechnicalHandlers | null {
  if (exportTypeId === "classes") {
    return {
      detect: detectClassesRaw,
      validate: validateClassesJsonl,
      convert: convertClasses,
      testQuestions: buildClassesTestQuestions,
      ragTest: runClassesRagTest,
      approveSummary: "Klassen-Datenbasis freigegeben — Programme entsperrt",
      approveMessage: "Freigegeben — nächster Typ (Programme) ist vorbereitet",
      sapConfirmSummary:
        "SAP-Export bestätigt (Z_AI_REPOSITORY_EXPORT / Klassen)",
    };
  }
  if (exportTypeId === "programs") {
    return {
      detect: detectProgramsRaw,
      validate: validateProgramsJsonl,
      convert: convertPrograms,
      testQuestions: buildProgramsTestQuestions,
      ragTest: async () => runProgramsRagTestSkipped(),
      approveSummary:
        "Programme freigegeben (parallel; classes/master-data unberührt)",
      approveMessage: "Programme freigegeben — kein Index/OpenAI",
      sapConfirmSummary:
        "SAP-Export Programme bestätigt (Z_AI_REPOSITORY_EXPORT / SAP_PROGRAMS)",
    };
  }
  if (exportTypeId === "function-modules") {
    return {
      detect: detectFunctionModulesRaw,
      validate: validateFunctionModulesJsonl,
      convert: convertFunctionModules,
      testQuestions: buildFunctionModulesTestQuestions,
      ragTest: async () => runFunctionModulesRagTestSkipped(),
      approveSummary:
        "Funktionsbausteine freigegeben (parallel; classes/programs unberührt)",
      approveMessage: "Funktionsbausteine freigegeben — kein Index/OpenAI",
      sapConfirmSummary:
        "SAP-Export Funktionsbausteine bestätigt (SAP_FUNCTION_MODULES)",
    };
  }
  if (exportTypeId === "materials") {
    return {
      detect: detectMaterialsRaw,
      validate: validateMaterialsJsonl,
      convert: convertMaterials,
      testQuestions: buildMaterialsTestQuestions,
      ragTest: async () => runMaterialsRagTestSkipped(),
      approveSummary:
        "Materialstammdaten freigegeben (parallel; Klassen-Kette unberührt)",
      approveMessage: "Materials freigegeben — classes/programs unverändert",
      sapConfirmSummary:
        "SAP-Export Materialstammdaten bestätigt (Report/Typ noch unknown)",
    };
  }
  if (exportTypeId === "customers") {
    return {
      detect: detectCustomersRaw,
      validate: validateCustomersJsonl,
      convert: convertCustomers,
      testQuestions: buildCustomersTestQuestions,
      ragTest: async () => runCustomersRagTestSkipped(),
      approveSummary:
        "Kundenstammdaten freigegeben (parallel; classes/materials unberührt)",
      approveMessage: "Customers freigegeben — andere Domains unverändert",
      sapConfirmSummary:
        "SAP-Export Kundenstammdaten bestätigt (MASTER_* / CUSTOMER)",
    };
  }
  if (exportTypeId === "vendors") {
    return {
      detect: detectVendorsRaw,
      validate: validateVendorsJsonl,
      convert: convertVendors,
      testQuestions: buildVendorsTestQuestions,
      ragTest: async () => runVendorsRagTestSkipped(),
      approveSummary:
        "Lieferantenstammdaten freigegeben (parallel; classes/materials unberührt)",
      approveMessage: "Vendors freigegeben — andere Domains unverändert",
      sapConfirmSummary:
        "SAP-Export Lieferantenstammdaten bestätigt (MASTER_* / VENDOR)",
    };
  }
  return null;
}

export async function runDatenbasisStep(
  params: RunStepParams,
): Promise<RunStepResult> {
  const projectKey = params.projectKey.trim() || "P01";
  const cfg = getExportTypeConfig(params.exportTypeId);
  if (!cfg) {
    throw new Error(`Unbekannter Exporttyp: ${params.exportTypeId}`);
  }

  const stage2 = reconcileSetupStage2(projectKey);
  const unlocks = computeUnlockMap(projectKey, isStage2Done(stage2));
  let manifest = reconcileManifest(
    projectKey,
    params.exportTypeId,
    Boolean(unlocks[params.exportTypeId]),
  );

  if (cfg.implementation !== "full") {
    return {
      ok: false,
      message:
        cfg.certainty === "unknown"
          ? "Exporttyp noch Scaffold (Regeln nicht verifiziert)"
          : "Pipeline für diesen Typ in Phase 1 nicht freigeschaltet",
      manifest,
    };
  }

  const handlers = handlersFor(params.exportTypeId);
  if (!handlers) {
    return {
      ok: false,
      message: `Keine Pipeline-Handler für ${params.exportTypeId}`,
      manifest,
    };
  }

  const gate = ensureReady(manifest, params.stepId);
  if (gate) {
    return { ok: false, message: gate, manifest };
  }

  switch (params.stepId) {
    case "A_sap_export": {
      if (!params.confirm) {
        return {
          ok: false,
          message: "Bitte SAP-Export manuell bestätigen",
          manifest,
        };
      }
      manifest = {
        ...manifest,
        steps: {
          ...manifest.steps,
          A_sap_export: {
            ...manifest.steps.A_sap_export,
            status: "done",
            confirmed_at: nowIso(),
            result: {
              summary: handlers.sapConfirmSummary,
              ok: true,
            },
            updated_at: nowIso(),
          },
        },
      };
      manifest = advanceAfterSuccess(manifest, "A_sap_export");
      saveManifest(projectKey, manifest);
      return {
        ok: true,
        message: "SAP-Export bestätigt — weiter mit RAW-Erkennung",
        manifest,
      };
    }

    case "B_raw_detect": {
      manifest = markStepRunning(manifest, "B_raw_detect");
      saveManifest(projectKey, manifest);
      const detect = await handlers.detect(
        projectKey,
        params.selectedRawFile ?? manifest.selected_raw_file,
      );
      if (!detect.ok || !detect.selected) {
        manifest = markStepError(manifest, "B_raw_detect", detect.result);
        if (detect.result.technical?.needs_selection) {
          manifest = {
            ...manifest,
            steps: {
              ...manifest.steps,
              B_raw_detect: {
                ...manifest.steps.B_raw_detect,
                status: "ready",
                result: detect.result,
              },
            },
            overall: "in_progress",
          };
        }
        saveManifest(projectKey, manifest);
        return {
          ok: false,
          message: detect.result.summary,
          manifest,
        };
      }
      manifest = {
        ...manifest,
        selected_raw_file: detect.selected.fileName,
        source_fingerprint: detect.result.counts
          ? `${detect.selected.fileName}:${detect.selected.bytes}`
          : manifest.source_fingerprint,
        steps: {
          ...manifest.steps,
          B_raw_detect: {
            ...manifest.steps.B_raw_detect,
            result: detect.result,
            updated_at: nowIso(),
          },
        },
      };
      manifest = advanceAfterSuccess(manifest, "B_raw_detect");
      saveManifest(projectKey, manifest);
      return { ok: true, message: detect.result.summary, manifest };
    }

    case "C_validate": {
      const file = manifest.selected_raw_file;
      if (!file) {
        return {
          ok: false,
          message: "Keine RAW-Datei ausgewählt — zuerst Schritt B",
          manifest,
        };
      }
      manifest = markStepRunning(manifest, "C_validate");
      saveManifest(projectKey, manifest);
      const v = await handlers.validate(projectKey, file);
      if (!v.ok) {
        manifest = markStepError(manifest, "C_validate", v.result);
        saveManifest(projectKey, manifest);
        return { ok: false, message: v.result.summary, manifest };
      }
      manifest = {
        ...manifest,
        steps: {
          ...manifest.steps,
          C_validate: {
            ...manifest.steps.C_validate,
            result: v.result,
            updated_at: nowIso(),
          },
        },
      };
      manifest = advanceAfterSuccess(manifest, "C_validate");
      saveManifest(projectKey, manifest);
      return { ok: true, message: v.result.summary, manifest };
    }

    case "D_convert": {
      const file = manifest.selected_raw_file;
      if (!file) {
        return {
          ok: false,
          message: "Keine RAW-Datei ausgewählt",
          manifest,
        };
      }
      manifest = markStepRunning(manifest, "D_convert");
      saveManifest(projectKey, manifest);
      const c = await Promise.resolve(handlers.convert(projectKey, file));
      if (!c.ok) {
        manifest = markStepError(manifest, "D_convert", c.result);
        saveManifest(projectKey, manifest);
        return { ok: false, message: c.result.summary, manifest };
      }
      manifest = {
        ...manifest,
        steps: {
          ...manifest.steps,
          D_convert: {
            ...manifest.steps.D_convert,
            result: c.result,
            updated_at: nowIso(),
          },
        },
      };
      manifest = advanceAfterSuccess(manifest, "D_convert");
      saveManifest(projectKey, manifest);
      return { ok: true, message: c.result.summary, manifest };
    }

    case "E_test_questions": {
      manifest = markStepRunning(manifest, "E_test_questions");
      saveManifest(projectKey, manifest);
      const t = handlers.testQuestions(projectKey);
      if (!t.ok) {
        manifest = markStepError(manifest, "E_test_questions", t.result);
        saveManifest(projectKey, manifest);
        return { ok: false, message: t.result.summary, manifest };
      }
      manifest = {
        ...manifest,
        steps: {
          ...manifest.steps,
          E_test_questions: {
            ...manifest.steps.E_test_questions,
            result: t.result,
            updated_at: nowIso(),
          },
        },
      };
      manifest = advanceAfterSuccess(manifest, "E_test_questions");
      saveManifest(projectKey, manifest);
      return { ok: true, message: t.result.summary, manifest };
    }

    case "F_rag_test": {
      manifest = markStepRunning(manifest, "F_rag_test");
      saveManifest(projectKey, manifest);
      const questions =
        manifest.steps.E_test_questions.result?.cases?.map((c) => c.question) ??
        [];
      const r = await handlers.ragTest(projectKey, questions);
      if (!r.ok) {
        manifest = markStepError(manifest, "F_rag_test", r.result);
        saveManifest(projectKey, manifest);
        return { ok: false, message: r.result.summary, manifest };
      }
      manifest = {
        ...manifest,
        steps: {
          ...manifest.steps,
          F_rag_test: {
            ...manifest.steps.F_rag_test,
            result: r.result,
            updated_at: nowIso(),
          },
        },
      };
      manifest = advanceAfterSuccess(manifest, "F_rag_test");
      saveManifest(projectKey, manifest);
      return { ok: true, message: r.result.summary, manifest };
    }

    case "G_approve": {
      if (!params.confirm) {
        return {
          ok: false,
          message: "Bitte Freigabe manuell bestätigen",
          manifest,
        };
      }
      manifest = {
        ...manifest,
        steps: {
          ...manifest.steps,
          G_approve: {
            ...manifest.steps.G_approve,
            status: "done",
            approved_at: nowIso(),
            result: {
              summary: handlers.approveSummary,
              ok: true,
            },
            updated_at: nowIso(),
          },
        },
        overall: "approved",
        updated_at: nowIso(),
      };
      saveManifest(projectKey, manifest);
      // Unlock next sequential types (independent types ignore this chain)
      const unlocks2 = computeUnlockMap(projectKey, true);
      for (const [id, unlocked] of Object.entries(unlocks2)) {
        reconcileManifest(projectKey, id, unlocked);
      }
      manifest = loadManifest(projectKey, params.exportTypeId) ?? manifest;
      return {
        ok: true,
        message: handlers.approveMessage,
        manifest,
      };
    }

    default:
      return { ok: false, message: "Unbekannter Schritt", manifest };
  }
}
