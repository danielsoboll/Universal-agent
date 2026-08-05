import Link from "next/link";
import {
  canAccessApp,
  primaryCustomerId,
  requireAppAccess,
} from "@/lib/onboarding/access";
import { EmptyState, InlineError } from "@/components/ui/states";
import { SetupOverallProgress } from "@/components/admin/setup/SetupOverallProgress";
import {
  buildDashboardOverview,
  loadScopedCustomers,
} from "@/lib/admin/loadDashboardSetup";

export default async function AppOverviewPage({
  searchParams,
}: {
  searchParams: Promise<{ customer?: string }>;
}) {
  const ctx = await requireAppAccess();
  const sp = await searchParams;

  const { customers, error: customersError } = await loadScopedCustomers(ctx);
  if (customersError) {
    console.error("[app] customers", customersError);
    return (
      <div className="space-y-3">
        <h1 className="text-[1.5rem] font-semibold tracking-tight sm:text-[1.75rem]">
          Übersicht
        </h1>
        <InlineError
          title="Projekte nicht ladbar"
          message="Die Projektliste konnte nicht geladen werden. Bitte später erneut versuchen."
        />
      </div>
    );
  }

  // Prefer explicit ?customer=, then profile primary, then first membership.
  const requestedId = sp.customer || primaryCustomerId(ctx) || customers[0]?.id;
  const customerId =
    requestedId &&
    customers.some((c) => c.id === requestedId) &&
    canAccessApp(ctx, requestedId)
      ? requestedId
      : customers[0]?.id;

  if (!customerId && !ctx.isPlatformAdmin && !ctx.isGeneralAdmin) {
    return (
      <EmptyState
        title="Kein Projekt"
        message="Ihrem Konto ist noch kein Projekt zugeordnet."
        actionHref="/"
        actionLabel="Zur Startseite"
      />
    );
  }

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

  const showProjectSwitcher = customers.length > 1;

  return (
    <div className="space-y-4 sm:space-y-5">
      <div>
        <h1 className="text-[1.5rem] font-semibold tracking-tight sm:text-[1.75rem]">
          Übersicht
        </h1>
        {selectedCustomer ? (
          <p className="mt-1 text-[0.9375rem] text-[var(--muted)] break-words">
            {selectedCustomer.name}
          </p>
        ) : null}
      </div>

      <Link
        href="/app/ask"
        className="btn btn-primary flex min-h-12 w-full items-center justify-center text-[1.0625rem]"
      >
        Frage stellen
      </Link>

      {showProjectSwitcher ? (
        <section className="rounded-[12px] border border-[var(--border)] bg-[var(--panel)] p-3">
          <p className="text-[0.875rem] font-medium text-[var(--muted)]">
            Projekt wechseln
          </p>
          <ul className="mt-2 space-y-1">
            {customers.map((c) => {
              const current = c.id === customerId;
              return (
                <li key={c.id}>
                  <Link
                    href={`/app?customer=${c.id}`}
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
        </section>
      ) : null}

      {overview ? (
        <SetupOverallProgress
          percent={overview.overallPercent}
          doneCount={overview.doneCount}
          totalCount={overview.totalCount}
          sentence={overview.overallSentence}
        />
      ) : (
        <EmptyState
          title="Kein Projekt zugeordnet"
          message="Ihrem Konto ist noch kein Kundenprojekt zugewiesen"
        />
      )}
    </div>
  );
}
