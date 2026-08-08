"use server";

import { revalidatePath } from "next/cache";
import {
  canMutateProjectSetup,
  requireProjectConsoleAccess,
  PROJECT_ADMIN_REQUIRED_HINT,
} from "@/lib/onboarding/access";
import {
  loadScopedCustomers,
  refreshDashboardOverview,
} from "@/lib/admin/loadDashboardSetup";

/**
 * Explicit admin action: disk reconcile + persist small setup snapshot.
 * Must not be called from page render.
 */
export async function refreshSetupStatusAction(params: {
  customerId: string;
}): Promise<{
  ok: boolean;
  message: string;
  overallPercent: number | null;
  updatedAt: string | null;
}> {
  const ctx = await requireProjectConsoleAccess();
  if (!canMutateProjectSetup(ctx)) {
    return {
      ok: false,
      message: PROJECT_ADMIN_REQUIRED_HINT,
      overallPercent: null,
      updatedAt: null,
    };
  }

  const { customers } = await loadScopedCustomers(ctx);
  const selected = customers.find((c) => c.id === params.customerId);
  if (!selected) {
    return {
      ok: false,
      message: "Projekt nicht gefunden oder kein Zugriff.",
      overallPercent: null,
      updatedAt: null,
    };
  }

  try {
    const overview = await refreshDashboardOverview({
      ctx,
      customerId: params.customerId,
      selected,
    });

    revalidatePath("/admin/dashboard");
    revalidatePath("/app");
    revalidatePath(`/admin/dashboard?customer=${params.customerId}`);
    revalidatePath(`/app?customer=${params.customerId}`);

    return {
      ok: true,
      message: `Setup-Status aktualisiert (${overview.overallPercent} %). Schwere Disk-Prüfung abgeschlossen.`,
      overallPercent: overview.overallPercent,
      updatedAt: new Date().toISOString(),
    };
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Status-Aktualisierung fehlgeschlagen.";
    return {
      ok: false,
      message,
      overallPercent: null,
      updatedAt: null,
    };
  }
}
