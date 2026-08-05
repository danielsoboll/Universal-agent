"use server";

import { revalidatePath } from "next/cache";
import {
  canMutateProjectSetup,
  requireProjectConsoleAccess,
  PROJECT_ADMIN_REQUIRED_HINT,
} from "@/lib/onboarding/access";
import {
  DATENBASIS_STEP_IDS,
  loadManifest,
  runDatenbasisStep,
  type DatenbasisManifest,
  type DatenbasisStepId,
  loadMessageIdocStatus,
  prepareMessageIdocConfig,
  loadMessageIdocRawManifest,
  describePlannedCanonicalModel,
  type MessageIdocStatusSnapshot,
  type MessageIdocRawManifest,
} from "@/lib/admin/datenbasis";
import { getLocalDataRoot } from "@/lib/localData/root";
import { reconcileManifest, computeUnlockMap } from "@/lib/admin/datenbasis/manifestStore";
import {
  isStage2Done,
  reconcileSetupStage2,
} from "@/lib/admin/datenbasis/projectStructure";

function revalidateDatenbasis(exportTypeId: string, customerId?: string | null) {
  revalidatePath("/admin/dashboard");
  revalidatePath("/admin/steps/3");
  revalidatePath(`/admin/steps/3/${exportTypeId}`);
  if (customerId) {
    revalidatePath(`/admin/steps/3?customer=${customerId}`);
  }
}

export async function getDatenbasisManifestAction(params: {
  projectKey?: string;
  exportTypeId: string;
}): Promise<{
  manifest: DatenbasisManifest;
  canRun: boolean;
}> {
  const ctx = await requireProjectConsoleAccess();
  getLocalDataRoot();
  const key = (params.projectKey ?? "P01").trim() || "P01";
  const stage2 = reconcileSetupStage2(key);
  const unlocks = computeUnlockMap(key, isStage2Done(stage2));
  const manifest = reconcileManifest(
    key,
    params.exportTypeId,
    Boolean(unlocks[params.exportTypeId]),
  );
  return { manifest, canRun: canMutateProjectSetup(ctx) };
}

export async function runDatenbasisStepAction(params: {
  projectKey?: string;
  exportTypeId: string;
  stepId: string;
  selectedRawFile?: string | null;
  confirm?: boolean;
  customerId?: string | null;
}): Promise<{
  ok: boolean;
  message: string;
  manifest: DatenbasisManifest;
}> {
  const ctx = await requireProjectConsoleAccess();
  const key = (params.projectKey ?? "P01").trim() || "P01";
  const fallback =
    loadManifest(key, params.exportTypeId) ??
    reconcileManifest(key, params.exportTypeId, false);

  if (!canMutateProjectSetup(ctx)) {
    return {
      ok: false,
      message: PROJECT_ADMIN_REQUIRED_HINT,
      manifest: fallback,
    };
  }

  if (
    !(DATENBASIS_STEP_IDS as readonly string[]).includes(params.stepId)
  ) {
    return {
      ok: false,
      message: "Ungültiger Schritt",
      manifest: fallback,
    };
  }

  getLocalDataRoot();
  try {
    const res = await runDatenbasisStep({
      projectKey: key,
      exportTypeId: params.exportTypeId,
      stepId: params.stepId as DatenbasisStepId,
      selectedRawFile: params.selectedRawFile,
      confirm: params.confirm,
    });
    revalidateDatenbasis(params.exportTypeId, params.customerId);
    return res;
  } catch (e) {
    return {
      ok: false,
      message: e instanceof Error ? e.message : String(e),
      manifest: loadManifest(key, params.exportTypeId) ?? fallback,
    };
  }
}

export async function getMessageIdocConfigStatusAction(params?: {
  projectKey?: string;
}): Promise<{
  status: MessageIdocStatusSnapshot;
  manifest: MessageIdocRawManifest | null;
  plannedModel: ReturnType<typeof describePlannedCanonicalModel>;
  canRun: boolean;
}> {
  const ctx = await requireProjectConsoleAccess();
  getLocalDataRoot();
  const key = (params?.projectKey ?? "P01").trim() || "P01";
  return {
    status: loadMessageIdocStatus(key),
    manifest: loadMessageIdocRawManifest(key),
    plannedModel: describePlannedCanonicalModel(),
    canRun: canMutateProjectSetup(ctx),
  };
}

export async function prepareMessageIdocConfigAction(params?: {
  projectKey?: string;
  customerId?: string | null;
}): Promise<{
  ok: boolean;
  message: string;
  status: MessageIdocStatusSnapshot;
  manifest: MessageIdocRawManifest | null;
}> {
  const ctx = await requireProjectConsoleAccess();
  const key = (params?.projectKey ?? "P01").trim() || "P01";
  const fallbackStatus = loadMessageIdocStatus(key);

  if (!canMutateProjectSetup(ctx)) {
    return {
      ok: false,
      message: PROJECT_ADMIN_REQUIRED_HINT,
      status: fallbackStatus,
      manifest: loadMessageIdocRawManifest(key),
    };
  }

  getLocalDataRoot();
  try {
    const res = await prepareMessageIdocConfig(key);
    revalidateDatenbasis("message-idoc-config", params?.customerId);
    return {
      ok: res.ok,
      message: res.message,
      status: res.status,
      manifest: res.manifest,
    };
  } catch (e) {
    return {
      ok: false,
      message: e instanceof Error ? e.message : String(e),
      status: loadMessageIdocStatus(key),
      manifest: loadMessageIdocRawManifest(key),
    };
  }
}
