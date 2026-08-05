"use server";

import { revalidatePath } from "next/cache";
import {
  canMutateProjectSetup,
  requireProjectConsoleAccess,
  PROJECT_ADMIN_REQUIRED_HINT,
} from "@/lib/onboarding/access";
import {
  confirmStage2Complete,
  ensureProjectStructure,
  loadSetupStage2State,
  reconcileSetupStage2,
  type SetupStage2State,
} from "@/lib/admin/datenbasis";
import { getLocalDataRoot } from "@/lib/localData/root";

function revalidateSetup(customerId?: string | null) {
  revalidatePath("/admin/dashboard");
  revalidatePath("/admin/steps/2");
  if (customerId) {
    revalidatePath(`/admin/steps/2?customer=${customerId}`);
  }
}

export async function getSetupStage2Action(projectKey = "P01"): Promise<{
  state: SetupStage2State;
  canRun: boolean;
}> {
  const ctx = await requireProjectConsoleAccess();
  getLocalDataRoot();
  const key = projectKey.trim() || "P01";
  return {
    state: reconcileSetupStage2(key),
    canRun: canMutateProjectSetup(ctx),
  };
}

export async function ensureProjectStructureAction(params: {
  projectKey?: string;
  customerId?: string | null;
}): Promise<{ ok: boolean; message: string; state: SetupStage2State }> {
  const ctx = await requireProjectConsoleAccess();
  if (!canMutateProjectSetup(ctx)) {
    return {
      ok: false,
      message: PROJECT_ADMIN_REQUIRED_HINT,
      state: loadSetupStage2State(params.projectKey ?? "P01"),
    };
  }
  getLocalDataRoot();
  const key = (params.projectKey ?? "P01").trim() || "P01";
  try {
    const check = ensureProjectStructure(key);
    const state = reconcileSetupStage2(key);
    revalidateSetup(params.customerId);
    return {
      ok: check.ok,
      message: check.ok
        ? "Ordnerstruktur angelegt / geprüft"
        : `Noch fehlend: ${check.missing.slice(0, 4).join(", ")}`,
      state,
    };
  } catch (e) {
    return {
      ok: false,
      message: e instanceof Error ? e.message : String(e),
      state: loadSetupStage2State(key),
    };
  }
}

export async function confirmStage2CompleteAction(params: {
  projectKey?: string;
  complete: boolean;
  customerId?: string | null;
}): Promise<{ ok: boolean; message: string; state: SetupStage2State }> {
  const ctx = await requireProjectConsoleAccess();
  if (!canMutateProjectSetup(ctx)) {
    return {
      ok: false,
      message: PROJECT_ADMIN_REQUIRED_HINT,
      state: loadSetupStage2State(params.projectKey ?? "P01"),
    };
  }
  getLocalDataRoot();
  const key = (params.projectKey ?? "P01").trim() || "P01";
  try {
    const state = confirmStage2Complete(key, params.complete);
    revalidateSetup(params.customerId);
    return {
      ok: true,
      message: params.complete
        ? "Stufe 2 manuell abgeschlossen"
        : "Abschluss zurückgenommen",
      state,
    };
  } catch (e) {
    return {
      ok: false,
      message: e instanceof Error ? e.message : String(e),
      state: loadSetupStage2State(key),
    };
  }
}
