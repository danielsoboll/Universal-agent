"use server";

import { revalidatePath } from "next/cache";
import { getLocalDataRoot } from "@/lib/localData/root";
import {
  canMutateProjectSetup,
  PROJECT_ADMIN_REQUIRED_HINT,
  requireProjectConsoleAccess,
} from "@/lib/onboarding/access";
import { isExportGroupId } from "@/lib/admin/exportGroups/definitions";
import {
  ORG_POINT_KEYS,
  setOrgConfirmation,
  ZY_ORG_POINT_KEYS,
} from "@/lib/admin/exportGroups/orgState";
import type { ExportGroupsOrgState } from "@/lib/admin/exportGroups/types";

const ALLOWED_KEYS = new Set<string>([
  ...ORG_POINT_KEYS,
  ...ZY_ORG_POINT_KEYS,
]);

export async function confirmExportGroupOrgPointAction(params: {
  projectKey?: string;
  groupId: string;
  key: string;
  confirmed: boolean;
}): Promise<{ ok: boolean; message: string; state?: ExportGroupsOrgState }> {
  const ctx = await requireProjectConsoleAccess();
  if (!canMutateProjectSetup(ctx)) {
    return { ok: false, message: PROJECT_ADMIN_REQUIRED_HINT };
  }

  if (!isExportGroupId(params.groupId)) {
    return { ok: false, message: "Unbekannte Exportgruppe" };
  }
  if (!ALLOWED_KEYS.has(params.key)) {
    return { ok: false, message: "Unbekannter Organisationspunkt" };
  }

  try {
    getLocalDataRoot();
    const projectKey = (params.projectKey ?? "P01").trim() || "P01";
    const state = setOrgConfirmation({
      projectKey,
      groupId: params.groupId,
      key: params.key,
      confirmed: params.confirmed,
    });
    revalidatePath("/admin/dashboard");
    revalidatePath("/admin/steps", "layout");
    return {
      ok: true,
      message: params.confirmed ? "Bestätigt" : "Zurückgesetzt",
      state,
    };
  } catch (error) {
    return {
      ok: false,
      message:
        error instanceof Error
          ? error.message
          : "Organisationsstatus konnte nicht gespeichert werden",
    };
  }
}
