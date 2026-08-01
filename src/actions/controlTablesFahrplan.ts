"use server";

import { revalidatePath } from "next/cache";
import { loadCustomerConfig, resolveSystemId } from "@/lib/core/customerConfig";
import { getLocalDataRoot } from "@/lib/localData/root";
import {
  canAccessProjectConsole,
  canMutateProjectSetup,
  getAccessContext,
  PROJECT_ADMIN_REQUIRED_HINT,
  requireProjectConsoleAccess,
  type AccessContext,
} from "@/lib/onboarding/access";
import {
  loadControlTablesFahrplanState,
  reconcileControlTablesFahrplanFromDisk,
  runControlTablesFahrplanStep,
  syncControlTablesFahrplanFromActiveEvidence,
  verifyExistingKnowledge,
  type ActiveControlTablesEvidence,
} from "@/lib/rebuild/controlTablesFahrplan";
import type {
  ControlTablesFahrplanState,
  FahrplanStepId,
} from "@/lib/rebuild/controlTablesFahrplanTypes";
import { FAHRPLAN_STEP_IDS } from "@/lib/rebuild/controlTablesFahrplanTypes";

export type FahrplanAccess = {
  canView: boolean;
  canRun: boolean;
  showTechDetails: boolean;
  roleLabel: string;
};

function resolveFahrplanAccess(ctx: AccessContext): FahrplanAccess {
  const isGeneral =
    ctx.isGeneralAdmin || ctx.isPlatformAdmin || ctx.role === "general_admin";
  return {
    canView: canAccessProjectConsole(ctx),
    canRun: canMutateProjectSetup(ctx),
    showTechDetails: isGeneral,
    roleLabel: ctx.roleLabel,
  };
}

function resolveProjectIds(projectKey: string): {
  customerId: string;
  systemId: string;
} {
  try {
    const cfg = loadCustomerConfig(projectKey);
    return {
      customerId: cfg.customer_id,
      systemId: resolveSystemId(cfg, undefined),
    };
  } catch {
    // Fallback for P01-style folders without customers/*.json mismatch
    return { customerId: projectKey, systemId: projectKey };
  }
}

export async function getControlTablesFahrplanAction(
  projectKey = "P01",
): Promise<{
  state: ControlTablesFahrplanState;
  access: FahrplanAccess;
  projectKey: string;
}> {
  const ctx = await requireProjectConsoleAccess();
  getLocalDataRoot();
  const access = resolveFahrplanAccess(ctx);
  const key = projectKey.trim() || "P01";
  // Status mirrors on-disk RAW / Canonical / Index — not checklist fiction.
  const state = reconcileControlTablesFahrplanFromDisk(key);
  return { state, access, projectKey: key };
}

export async function runControlTablesFahrplanStepAction(params: {
  projectKey?: string;
  stepId: number;
}): Promise<{
  ok: boolean;
  message: string;
  state: ControlTablesFahrplanState;
}> {
  const ctx = await requireProjectConsoleAccess();
  const access = resolveFahrplanAccess(ctx);
  if (!access.canRun) {
    return {
      ok: false,
      message: PROJECT_ADMIN_REQUIRED_HINT,
      state: loadControlTablesFahrplanState(params.projectKey ?? "P01"),
    };
  }

  getLocalDataRoot();
  const projectKey = (params.projectKey ?? "P01").trim() || "P01";
  const stepId = params.stepId as FahrplanStepId;
  if (!FAHRPLAN_STEP_IDS.includes(stepId)) {
    return {
      ok: false,
      message: `Ungültiger Schritt: ${params.stepId}`,
      state: loadControlTablesFahrplanState(projectKey),
    };
  }

  const { customerId, systemId: fallbackSystem } = resolveProjectIds(projectKey);
  const current = loadControlTablesFahrplanState(projectKey);
  const fromSources = current.steps[1]?.result?.technical?.system_ids;
  const peeked =
    Array.isArray(fromSources) && typeof fromSources[0] === "string"
      ? fromSources[0]
      : null;
  const systemId = peeked || fallbackSystem;

  const result = await runControlTablesFahrplanStep({
    projectKey,
    stepId,
    customerId,
    systemId,
  });

  revalidatePath("/admin/extraction");
  revalidatePath("/admin/dashboard");
  revalidatePath("/admin/steps", "layout");
  return {
    ok: result.ok,
    message: result.message,
    state: result.state,
  };
}

/** Soft poll helper for UI (admin only). */
export async function pollControlTablesFahrplanAction(
  projectKey = "P01",
): Promise<ControlTablesFahrplanState> {
  const ctx = await getAccessContext();
  if (!ctx || !canAccessProjectConsole(ctx)) {
    throw new Error("Kein Zugriff auf den Projekt-Status.");
  }
  getLocalDataRoot();
  return loadControlTablesFahrplanState(projectKey.trim() || "P01");
}

/**
 * Verify-only: sync steps 2–4 from active Q01 evidence (no RAW reconvert / wipe).
 */
export async function syncControlTablesFahrplanFromEvidenceAction(
  projectKey = "P01",
): Promise<{
  ok: boolean;
  message: string;
  state: ControlTablesFahrplanState;
  evidence: ActiveControlTablesEvidence;
}> {
  const ctx = await requireProjectConsoleAccess();
  const access = resolveFahrplanAccess(ctx);
  if (!access.canRun) {
    return {
      ok: false,
      message: PROJECT_ADMIN_REQUIRED_HINT,
      state: loadControlTablesFahrplanState(projectKey),
      evidence: verifyExistingKnowledge(projectKey.trim() || "P01"),
    };
  }
  getLocalDataRoot();
  const key = projectKey.trim() || "P01";
  const result = syncControlTablesFahrplanFromActiveEvidence(key);
  revalidatePath("/admin/extraction");
  revalidatePath("/admin/dashboard");
  revalidatePath("/admin/steps", "layout");
  return result;
}
