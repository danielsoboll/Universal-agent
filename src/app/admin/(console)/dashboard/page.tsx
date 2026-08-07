import {
  canMutateProjectSetup,
  isProjectUser,
  primaryCustomerId,
  requireProjectConsoleAccess,
} from "@/lib/onboarding/access";
import { InlineError } from "@/components/ui/states";
import { ProjectSetupDashboard } from "@/components/admin/setup/ProjectSetupDashboard";
import {
  buildDashboardOverview,
  loadScopedCustomers,
} from "@/lib/admin/loadDashboardSetup";
import {
  demoListPercent,
} from "@/lib/admin/dashboardDemoDisplay";

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

  const overview =
    customerId && selectedCustomer
      ? await buildDashboardOverview({
          ctx,
          customerId,
          selected: selectedCustomer,
        })
      : null;

  // Real list bars for projects without demo fake (DGL stays visible when
  // another project is selected).
  const listPercentEntries = await Promise.all(
    customers.map(async (c) => {
      if (demoListPercent(c.name) != null) return null;
      if (c.id === customerId && overview) {
        return [c.id, overview.overallPercent] as const;
      }
      try {
        const o = await buildDashboardOverview({
          ctx,
          customerId: c.id,
          selected: c,
        });
        return [c.id, o.overallPercent] as const;
      } catch (err) {
        console.error("[admin/dashboard] list percent", c.id, err);
        return null;
      }
    }),
  );
  const listPercents: Record<string, number> = {};
  for (const entry of listPercentEntries) {
    if (entry) listPercents[entry[0]] = entry[1];
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
      overview={overview}
      listPercents={listPercents}
      readOnlyUser={readOnlyUser}
      // General Admin: all projects. Project Admin: membership-scoped (loadScopedCustomers).
      showProjectList
      showNewProject={isGeneralAdmin}
      showProjectAdmin={canMutate && Boolean(selectedCustomer)}
      canMutateStatus={canMutate}
      errorMessage={sp.error ?? null}
      deletedMessage={Boolean(sp.deleted)}
    />
  );
}
