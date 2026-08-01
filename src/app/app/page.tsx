import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import {
  primaryCustomerId,
  requireAppAccess,
} from "@/lib/onboarding/access";
import {
  MODULE_LABELS,
  type AppModuleKey,
} from "@/lib/onboarding/appProfileTypes";
import { EmptyState } from "@/components/ui/states";
import {
  FAHRPLAN_STEP_IDS,
  FAHRPLAN_STEP_META,
  FAHRPLAN_STEP_STATUS_LABELS_DE,
  getControlTablesNextAction,
} from "@/lib/rebuild/controlTablesFahrplanTypes";
import { reconcileControlTablesFahrplanFromDisk } from "@/lib/rebuild/controlTablesFahrplan";
import { getLocalDataRoot } from "@/lib/localData/root";

export default async function AppOverviewPage() {
  const ctx = await requireAppAccess();
  const customerId = primaryCustomerId(ctx);

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

  const supabase = await createClient();
  let customerName = ctx.customerName;
  let productModule: AppModuleKey = ctx.productModule;
  let status: string | null = null;
  let projectKey = (ctx.customerSlug ?? "").trim() || "P01";

  if (customerId) {
    const { data: customer } = await supabase
      .from("customers")
      .select("name, status, product_module, slug")
      .eq("id", customerId)
      .maybeSingle();
    if (customer) {
      customerName = customer.name;
      status = customer.status;
      if (customer.product_module) {
        productModule = customer.product_module as AppModuleKey;
      }
      if (customer.slug) projectKey = customer.slug;
    }
  }

  let ctError: string | null = null;
  let percent = 0;
  let done = 0;
  let nextLabel = "Z-/Y-Tabellen: Quelldateien erkennen";
  let stepRows: Array<{
    id: number;
    title: string;
    statusLabel: string;
    ok: boolean;
  }> = [];

  try {
    getLocalDataRoot();
    const state = reconcileControlTablesFahrplanFromDisk(projectKey);
    done = FAHRPLAN_STEP_IDS.filter(
      (id) => state.steps[id].status === "success",
    ).length;
    percent = Math.round((done / FAHRPLAN_STEP_IDS.length) * 100);
    nextLabel = getControlTablesNextAction(state).label;
    stepRows = FAHRPLAN_STEP_IDS.map((id) => ({
      id,
      title: FAHRPLAN_STEP_META[id].title,
      statusLabel: FAHRPLAN_STEP_STATUS_LABELS_DE[state.steps[id].status],
      ok: state.steps[id].status === "success",
    }));
  } catch (error) {
    ctError =
      error instanceof Error
        ? error.message
        : "Lokale Daten nicht verfügbar.";
  }

  return (
    <div className="space-y-4 sm:space-y-5">
      <div>
        <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">
          Projektübersicht
        </h1>
        <p className="muted mt-1 text-sm">
          {customerName ?? "Projekt"}
          {" · "}
          {MODULE_LABELS[productModule]}
          {status ? ` · ${status}` : ""}
        </p>
      </div>

      <section className="panel compact space-y-3 p-4 sm:p-5">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-[var(--muted)]">
              Datenimport
            </p>
            <p className="text-3xl font-semibold tracking-tight">{percent}%</p>
            <p className="muted mt-1 text-sm">
              {done} von {FAHRPLAN_STEP_IDS.length} technischen Schritten OK
            </p>
          </div>
          <Link href="/app/ask" className="btn btn-primary">
            Frage stellen
          </Link>
        </div>
        <div
          className="h-2 overflow-hidden rounded-full"
          style={{ background: "var(--border)" }}
          role="progressbar"
          aria-valuenow={percent}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div
            className="h-full rounded-full bg-[var(--accent)] transition-all"
            style={{ width: `${percent}%` }}
          />
        </div>
        <p className="text-sm">
          Nächste Aktion: <span className="font-medium">{nextLabel}</span>
        </p>
        {ctError ? (
          <p className="text-sm text-[var(--danger)]">{ctError}</p>
        ) : null}
      </section>

      <section className="space-y-3">
        <div>
          <h2 className="text-lg font-semibold">Z-/Y-Tabellen · Status</h2>
          <p className="muted text-sm">
            Technischer Importstand für{" "}
            <code className="font-mono">{projectKey}</code>
          </p>
        </div>
        {stepRows.length ? (
          <ul className="space-y-2">
            {stepRows.map((step) => (
              <li key={step.id} className="panel compact p-3 sm:p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span aria-hidden>{step.ok ? "✓" : "○"}</span>
                  <p className="font-medium">
                    {step.id}. {step.title}
                  </p>
                  <span className="muted text-sm">{step.statusLabel}</span>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState
            title="Kein Importstatus"
            message="Sobald der Admin den technischen Datenimport startet, erscheint hier der Status."
          />
        )}
      </section>
    </div>
  );
}
