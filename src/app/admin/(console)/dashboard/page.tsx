import {
  canMutateProjectSetup,
  isProjectUser,
  primaryCustomerId,
  requireProjectConsoleAccess,
} from "@/lib/onboarding/access";
import { InlineError } from "@/components/ui/states";
import { ProjectSetupDashboard } from "@/components/admin/setup/ProjectSetupDashboard";
import {
  loadCachedDashboardOverview,
  loadCachedOverallPercent,
} from "@/lib/admin/loadDashboardSetup";
import { loadScopedCustomers } from "@/lib/admin/loadScopedCustomers";
import { demoListPercent } from "@/lib/admin/dashboardDemoDisplay";

export default async function AdminDashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ customer?: string; error?: string; deleted?: string }>;
}) {
  const ctx = await requireProjectConsoleAccess();
  const sp = await searchParams;
  const isGeneralAdmin = ctx.isPlatformAdmin || ctx.isGeneralAdmin;
  const canMutate = canMutateProjectSetup(ctx);
  const readOnlyUser = isProjectUser(ctx);

  const { customers, error: customersError } = await loadScopedCustomers(ctx);
  if (customersError) {
    console.error("[admin/dashboard] customers", customersError);
    return (
      <div className="space-y-3">
        <h1 className="text-[1.5rem] font-semibold tracking-tight sm:text-[1.75rem]">
          Dashboard
        </h1>
        <InlineError
          title="Projekte nicht ladbar"
          message="Die Projektliste konnte nicht geladen werden. Bitte später erneut versuchen oder ein neues Projekt anlegen"
          actionHref={isGeneralAdmin ? "/admin/setup" : undefined}
          actionLabel={isGeneralAdmin ? "Neues Projekt anlegen" : undefined}
        />
      </div>
    );
  }

  const customerId =
    sp.customer ||
    customers[0]?.id ||
    primaryCustomerId(ctx) ||
    undefined;

  const selectedCustomer =
    customers.find((c) => c.id === customerId) ?? null;

  const cached =
    customerId && selectedCustomer
      ? loadCachedDashboardOverview({
          customerId,
          selected: selectedCustomer,
        })
      : { overview: null, source: "none" as const, updatedAt: null };

  // List bars: snapshot percents only — never N× disk reconcile on render.
  const listPercents: Record<string, number> = {};
  for (const c of customers) {
    if (demoListPercent(c.name) != null) continue;
    if (c.id === customerId && cached.overview) {
      listPercents[c.id] = cached.overview.overallPercent;
      continue;
    }
    const pct = loadCachedOverallPercent({
      customerId: c.id,
      selected: c,
    });
    if (pct != null) listPercents[c.id] = pct;
  }

  return (
    <ProjectSetupDashboard
      title="Dashboard"
      switchBasePath="/admin/dashboard"
      projects={customers.map((c) => ({ id: c.id, name: c.name }))}
      selectedCustomer={
        selectedCustomer
          ? { id: selectedCustomer.id, name: selectedCustomer.name }
          : null
      }
      overview={cached.overview}
      statusSource={cached.source}
      statusUpdatedAt={cached.updatedAt}
      listPercents={listPercents}
      readOnlyUser={readOnlyUser}
      showProjectList
      showNewProject={isGeneralAdmin}
      showProjectAdmin={canMutate && Boolean(selectedCustomer)}
      canMutateStatus={canMutate}
      errorMessage={sp.error ?? null}
      deletedMessage={Boolean(sp.deleted)}
    />
  );
}
