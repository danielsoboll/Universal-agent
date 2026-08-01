import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import {
  isProjectUser,
  primaryCustomerId,
  requireProjectConsoleAccess,
} from "@/lib/onboarding/access";
import { applyCustomerScopeFilter } from "@/lib/onboarding/customerQuery";
import { DeleteCustomerForm } from "@/components/onboarding/DeleteCustomerForm";
import { EmptyState, InlineError } from "@/components/ui/states";
import { PressNavigateLink } from "@/components/ui/PressNavigateLink";
import { SetupOverallProgress } from "@/components/admin/setup/SetupOverallProgress";
import { SetupStepCard } from "@/components/admin/setup/SetupStepCard";
import {
  computeSetupOverview,
  type ProjectSetupContext,
} from "@/lib/admin/setupMainSteps";

function resolveProjectKey(slug: string | null | undefined): string {
  const s = (slug ?? "").trim();
  return s || "P01";
}

export default async function AdminDashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ customer?: string; error?: string; deleted?: string }>;
}) {
  const ctx = await requireProjectConsoleAccess();
  const sp = await searchParams;
  const supabase = await createClient();
  const isGeneralAdmin = ctx.isPlatformAdmin || ctx.isGeneralAdmin;
  const readOnlyUser = isProjectUser(ctx);

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
    console.error("[admin/dashboard] customers", customersError.message);
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
    customers?.[0]?.id ||
    primaryCustomerId(ctx) ||
    undefined;

  const selectedCustomer = customers?.find((c) => c.id === customerId) ?? null;
  const projectKey = resolveProjectKey(selectedCustomer?.slug);

  let hasGoals = false;
  let membershipCount = 0;
  let userMembershipCount = 0;

  if (customerId) {
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
    if (goalsRes.error) {
      console.error("[admin/dashboard] goals", goalsRes.error.message);
    } else {
      hasGoals = (goalsRes.count ?? 0) > 0;
    }
    if (membersRes.error) {
      console.error("[admin/dashboard] memberships", membersRes.error.message);
    } else {
      const rows = membersRes.data ?? [];
      membershipCount = rows.length;
      userMembershipCount = rows.filter((r) => r.role === "customer_user").length;
    }
  }

  const setupCtx: ProjectSetupContext = {
    customerId: customerId ?? null,
    customerName: selectedCustomer?.name ?? null,
    customerSlug: selectedCustomer?.slug ?? null,
    customerStatus: selectedCustomer?.status ?? null,
    productModule: selectedCustomer?.product_module ?? ctx.productModule ?? null,
    projectKey,
    hasGoals,
    membershipCount,
    userMembershipCount,
  };

  const overview = customerId ? computeSetupOverview(setupCtx) : null;
  const currentSetupStep =
    overview?.nextStepId != null
      ? (overview.steps.find((s) => s.id === overview.nextStepId) ?? null)
      : null;
  const currentSetupStatusText = currentSetupStep
    ? currentSetupStep.title
    : overview
      ? "Alle Hauptschritte erledigt"
      : null;

  const currentProjectBlock =
    customerId && selectedCustomer && overview ? (
      <section className="admin-card project-current rounded-[12px] border p-3">
        <div className="flex items-baseline justify-between gap-2">
          <p className="text-[0.875rem] font-medium text-[var(--muted)]">
            Aktuelles Projekt
          </p>
          <span className="project-current-label">Aktuell</span>
        </div>
        <h2 className="mt-0.5 text-[1.25rem] font-medium leading-snug tracking-tight break-words text-[var(--foreground)]">
          {selectedCustomer.name}
        </h2>
        <p className="mt-0.5 text-[0.875rem] text-[var(--muted)] break-words">
          Status: {currentSetupStatusText}
        </p>
        {readOnlyUser ? (
          <p className="mt-2 text-[0.9375rem] text-[var(--muted)]">
            Ansicht für Projekt-Benutzer — Aktionen erledigt der Projekt-Admin.
          </p>
        ) : null}
        {overview.localDataError ? (
          <p className="mt-2 text-[0.9375rem] text-[var(--danger)] break-words">
            {overview.localDataError}
          </p>
        ) : null}
      </section>
    ) : null;

  return (
    <div className="space-y-3">
      <h1 className="text-[1.5rem] font-semibold tracking-tight sm:text-[1.75rem]">
        Dashboard
      </h1>

      {sp.error ? (
        <InlineError title="Aktion fehlgeschlagen" message={sp.error} />
      ) : null}
      {sp.deleted ? (
        <div className="rounded-[12px] border border-[var(--border)] bg-[var(--panel)] p-3 text-[1.0625rem]">
          Projekt wurde gelöscht.
        </div>
      ) : null}

      {/* General Admin: Projekte + Neues Projekt oben */}
      {isGeneralAdmin ? (
        <section className="admin-card rounded-[12px] border border-[var(--border)] bg-[var(--panel)] p-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="text-[0.875rem] font-medium text-[var(--muted)]">
              Projekte
            </p>
            <PressNavigateLink
              href="/admin/setup"
              className="btn-secondary-blue"
            >
              Neues Projekt anlegen
            </PressNavigateLink>
          </div>

          {!customers?.length ? (
            <EmptyState
              title="Noch kein Projekt"
              message="Legen Sie das erste Projekt an"
              actionHref="/admin/setup"
              actionLabel="Neues Projekt anlegen"
            />
          ) : (
            <ul className="mt-2 space-y-1">
              {customers.map((c) => {
                const current = c.id === customerId;
                return (
                  <li key={c.id}>
                    <Link
                      href={`/admin/dashboard?customer=${c.id}`}
                      className={`flex min-h-11 items-center justify-between gap-2 rounded-lg border px-2.5 py-2 text-[1.0625rem] ${
                        current
                          ? "project-current font-medium text-[var(--foreground)]"
                          : "border-transparent bg-[var(--surface)]/60 hover:border-[var(--border)]"
                      }`}
                    >
                      <span className="min-w-0 break-words">{c.name}</span>
                      {current ? (
                        <span className="project-current-label shrink-0">
                          Aktuell
                        </span>
                      ) : null}
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      ) : (
        currentProjectBlock
      )}

      {customerId && selectedCustomer && overview ? (
        <>
          {isGeneralAdmin ? currentProjectBlock : null}

          <SetupOverallProgress
            percent={overview.overallPercent}
            doneCount={overview.doneCount}
            totalCount={overview.totalCount}
            sentence={overview.overallSentence}
          />

          <section className="space-y-1.5">
            <p className="text-[0.8125rem] font-medium text-[var(--muted)]">
              Hauptschritte
            </p>
            <ol className="space-y-1.5">
              {overview.steps.map((step) => (
                <li key={step.id}>
                  <SetupStepCard step={step} />
                </li>
              ))}
            </ol>
          </section>

          {isGeneralAdmin ? (
            <details className="admin-card rounded-[12px] border border-[var(--border)] bg-[var(--panel)] p-3">
              <summary className="cursor-pointer text-[0.875rem] font-medium text-[var(--muted)] hover:text-[var(--foreground)]">
                Gefahrenzone
              </summary>
              <div className="mt-3">
                <DeleteCustomerForm
                  customerId={selectedCustomer.id}
                  customerName={selectedCustomer.name}
                  customerSlug={selectedCustomer.slug}
                />
              </div>
            </details>
          ) : null}
        </>
      ) : !isGeneralAdmin ? (
        <EmptyState
          title="Kein Projekt zugeordnet"
          message="Ihrem Konto ist noch kein Kundenprojekt zugewiesen"
        />
      ) : null}
    </div>
  );
}
