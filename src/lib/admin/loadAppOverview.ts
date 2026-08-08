import "server-only";
import type { AccessContext } from "@/lib/onboarding/access";
import { resolveBoundProjectKey } from "@/lib/localData/resolveDataProjectKey";
import type { DashboardCustomerRow } from "@/lib/admin/loadScopedCustomers";
import {
  readSetupStatusSnapshot,
  snapshotToOverview,
} from "@/lib/admin/setupStatusSnapshot";

/**
 * Lightweight Anwender overview — NO disk reconcile, NO knowledge load.
 * Prefer last admin-written snapshot; otherwise metadata-only placeholder.
 */
export type AppOverviewView = {
  projectKey: string;
  projectName: string;
  customerStatus: string | null;
  overallPercent: number;
  doneCount: number;
  totalCount: number;
  overallSentence: string;
  /** snapshot = small logs JSON; metadata = auth/DB fields only */
  source: "snapshot" | "metadata";
  updatedAt: string | null;
};

export async function buildAppOverviewLightweight(opts: {
  ctx: AccessContext;
  customerId: string;
  selected: DashboardCustomerRow;
}): Promise<AppOverviewView> {
  const projectKey = resolveBoundProjectKey({
    slug: opts.selected.slug,
    landscapeLabel: opts.selected.landscape_label,
    customerId: opts.customerId,
  });

  const snapshot = readSetupStatusSnapshot(projectKey);
  if (snapshot) {
    const overview = snapshotToOverview(snapshot);
    return {
      projectKey,
      projectName: opts.selected.name,
      customerStatus: opts.selected.status,
      overallPercent: overview.overallPercent,
      doneCount: overview.doneCount,
      totalCount: overview.totalCount,
      overallSentence: overview.overallSentence,
      source: "snapshot",
      updatedAt: snapshot.updatedAt,
    };
  }

  const statusLabel = opts.selected.status?.trim() || "unbekannt";
  return {
    projectKey,
    projectName: opts.selected.name,
    customerStatus: opts.selected.status,
    overallPercent: 0,
    doneCount: 0,
    totalCount: 6,
    overallSentence: `Projekt freigegeben (Status: ${statusLabel}). Detaillierter Setup-Fortschritt erscheint nach Admin „Status aktualisieren“.`,
    source: "metadata",
    updatedAt: null,
  };
}
