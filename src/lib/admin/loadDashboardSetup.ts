import "server-only";
import { createClient } from "@/lib/supabase/server";
import type { AccessContext } from "@/lib/onboarding/access";
import { applyCustomerScopeFilter } from "@/lib/onboarding/customerQuery";
import {
  computeSetupOverview,
  type ProjectSetupContext,
  type SetupOverview,
} from "@/lib/admin/setupMainSteps";

export type DashboardCustomerRow = {
  id: string;
  name: string;
  slug: string | null;
  status: string | null;
  product_module: string | null;
};

function resolveProjectKey(slug: string | null | undefined): string {
  const s = (slug ?? "").trim();
  return s || "P01";
}

/** Load customers visible to the current access context. */
export async function loadScopedCustomers(
  ctx: AccessContext,
): Promise<{ customers: DashboardCustomerRow[]; error: string | null }> {
  const supabase = await createClient();

  let customersQuery = supabase
    .from("customers")
    .select("id, name, slug, status, product_module")
    .order("created_at", { ascending: false });
  customersQuery = applyCustomerScopeFilter(customersQuery, ctx);

  let { data: customers, error: customersError } = await customersQuery;
  if (customersError && /product_module/i.test(customersError.message)) {
    let fallbackQuery = supabase
      .from("customers")
      .select("id, name, slug, status")
      .order("created_at", { ascending: false });
    fallbackQuery = applyCustomerScopeFilter(fallbackQuery, ctx);
    const retry = await fallbackQuery;
    customers = (retry.data ?? []).map((c) => ({
      ...c,
      product_module: null as string | null,
    }));
    customersError = retry.error;
  }

  if (customersError) {
    return { customers: [], error: customersError.message };
  }

  return {
    customers: (customers ?? []) as DashboardCustomerRow[],
    error: null,
  };
}

/** Goals + membership counts for setup step 1 / 6 progress. */
export async function loadSetupMembershipStats(customerId: string): Promise<{
  hasGoals: boolean;
  membershipCount: number;
  userMembershipCount: number;
}> {
  const supabase = await createClient();
  const [goalsRes, membersRes] = await Promise.all([
    supabase
      .from("project_goals")
      .select("id", { count: "exact", head: true })
      .eq("customer_id", customerId),
    supabase
      .from("customer_memberships")
      .select("role")
      .eq("customer_id", customerId)
      .eq("status", "active"),
  ]);

  let hasGoals = false;
  let membershipCount = 0;
  let userMembershipCount = 0;

  if (goalsRes.error) {
    console.error("[dashboard] goals", goalsRes.error.message);
  } else {
    hasGoals = (goalsRes.count ?? 0) > 0;
  }
  if (membersRes.error) {
    console.error("[dashboard] memberships", membersRes.error.message);
  } else {
    const rows = membersRes.data ?? [];
    membershipCount = rows.length;
    userMembershipCount = rows.filter((r) => r.role === "customer_user").length;
  }

  return { hasGoals, membershipCount, userMembershipCount };
}

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
    projectKey: resolveProjectKey(opts.selected.slug),
    hasGoals: stats.hasGoals,
    membershipCount: stats.membershipCount,
    userMembershipCount: stats.userMembershipCount,
  };
  return computeSetupOverview(setupCtx);
}
