import "server-only";
import type { AccessContext } from "@/lib/onboarding/access";
import {
  computeSetupOverview,
  type ProjectSetupContext,
  type SetupOverview,
} from "@/lib/admin/setupMainSteps";
import { resolveBoundProjectKey } from "@/lib/localData/resolveDataProjectKey";
import {
  loadScopedCustomers,
  loadSetupMembershipStats,
  type DashboardCustomerRow,
} from "@/lib/admin/loadScopedCustomers";
import {
  readSetupStatusSnapshot,
  snapshotToOverview,
  writeSetupStatusSnapshot,
} from "@/lib/admin/setupStatusSnapshot";

export type { DashboardCustomerRow };
export { loadScopedCustomers, loadSetupMembershipStats };

export type CachedDashboardOverview = {
  overview: SetupOverview | null;
  source: "snapshot" | "none";
  updatedAt: string | null;
};

/**
 * Render-safe: last known setup status only (small JSON).
 * Does NOT reconcile disk / control tables / embeddings.
 */
export function loadCachedDashboardOverview(opts: {
  customerId: string;
  selected: DashboardCustomerRow;
}): CachedDashboardOverview {
  const projectKey = resolveBoundProjectKey({
    slug: opts.selected.slug,
    landscapeLabel: opts.selected.landscape_label,
    customerId: opts.customerId,
  });
  const snapshot = readSetupStatusSnapshot(projectKey);
  if (!snapshot) {
    return { overview: null, source: "none", updatedAt: null };
  }
  return {
    overview: snapshotToOverview(snapshot),
    source: "snapshot",
    updatedAt: snapshot.updatedAt,
  };
}

/** List-bar percent from snapshot only (no disk reconcile). */
export function loadCachedOverallPercent(opts: {
  customerId: string;
  selected: DashboardCustomerRow;
}): number | null {
  const cached = loadCachedDashboardOverview(opts);
  return cached.overview?.overallPercent ?? null;
}

/**
 * Heavy path — explicit admin refresh only.
 * Runs full setup overview (disk reconcile) and persists a small snapshot.
 */
export async function refreshDashboardOverview(opts: {
  ctx: AccessContext;
  customerId: string;
  selected: DashboardCustomerRow;
}): Promise<SetupOverview> {
  const overview = await buildDashboardOverview(opts);
  writeSetupStatusSnapshot({
    customerId: opts.customerId,
    overview,
  });
  return overview;
}

/** @deprecated Prefer loadCachedDashboardOverview on render; refreshDashboardOverview on action. */
export async function buildDashboardOverview(opts: {
  ctx: AccessContext;
  customerId: string;
  selected: DashboardCustomerRow;
}): Promise<SetupOverview> {
  const stats = await loadSetupMembershipStats(opts.customerId);
  const setupCtx: ProjectSetupContext = {
    customerId: opts.customerId,
    customerName: opts.selected.name,
    customerSlug: opts.selected.slug,
    customerStatus: opts.selected.status,
    productModule:
      opts.selected.product_module ?? opts.ctx.productModule ?? null,
    projectKey: resolveBoundProjectKey({
      slug: opts.selected.slug,
      landscapeLabel: opts.selected.landscape_label,
      customerId: opts.customerId,
    }),
    hasGoals: stats.hasGoals,
    membershipCount: stats.membershipCount,
    userMembershipCount: stats.userMembershipCount,
  };
  return computeSetupOverview(setupCtx);
}
