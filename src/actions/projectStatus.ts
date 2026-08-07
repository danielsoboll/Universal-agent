"use server";

import { revalidatePath } from "next/cache";
import {
  canMutateProjectSetup,
  requireProjectConsoleAccess,
  PROJECT_ADMIN_REQUIRED_HINT,
} from "@/lib/onboarding/access";
import { getLocalDataRoot } from "@/lib/localData/root";
import { resolveBoundProjectKey } from "@/lib/localData/resolveDataProjectKey";
import { reconcileProjectStatus } from "@/lib/admin/projectStatus";
import { loadScopedCustomers } from "@/lib/admin/loadDashboardSetup";

/**
 * Read-only artifact reconciliation. Updates status metadata only.
 * Does not run pipelines, OpenAI, convert, or index rebuilds.
 */
export async function syncProjectStatusAction(params: {
  customerId: string;
}): Promise<{
  ok: boolean;
  message: string;
  running_count: number;
  corrections: number;
  warnings: number;
}> {
  const ctx = await requireProjectConsoleAccess();
  if (!canMutateProjectSetup(ctx)) {
    return {
      ok: false,
      message: PROJECT_ADMIN_REQUIRED_HINT,
      running_count: 0,
      corrections: 0,
      warnings: 0,
    };
  }

  getLocalDataRoot();
  const { customers } = await loadScopedCustomers(ctx);
  const selected = customers.find((c) => c.id === params.customerId);
  if (!selected) {
    return {
      ok: false,
      message: "Projekt nicht gefunden oder kein Zugriff.",
      running_count: 0,
      corrections: 0,
      warnings: 0,
    };
  }

  const projectKey = resolveBoundProjectKey({
    slug: selected.slug,
    landscapeLabel: selected.landscape_label,
    customerId: selected.id,
  });
  const result = reconcileProjectStatus({
    projectKey,
    projectId: selected.id,
    writeManifests: true,
  });

  revalidatePath("/admin/dashboard");
  revalidatePath("/admin/steps/3");
  revalidatePath("/admin/project");
  revalidatePath("/admin/pipeline-analyzer");
  if (params.customerId) {
    revalidatePath(`/admin/dashboard?customer=${params.customerId}`);
    revalidatePath(`/admin/steps/3?customer=${params.customerId}`);
  }

  const running = result.running_processes.length;
  const msgParts = [
    "Projektstatus aus Artefakten rekonstruiert.",
    result.manifests_updated.length
      ? `${result.manifests_updated.length} Manifest(e) angepasst.`
      : "Keine Manifest-Änderungen nötig.",
    running
      ? `${running} laufende(r) Prozess(e) erkannt (nicht verändert).`
      : "Keine laufenden Analyse-/Indexprozesse erkannt.",
  ];

  return {
    ok: true,
    message: msgParts.join(" "),
    running_count: running,
    corrections: result.ui_corrections.length,
    warnings: result.warnings.length,
  };
}
