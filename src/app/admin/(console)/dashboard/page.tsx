import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import {
  primaryCustomerId,
  requireAdminAccess,
} from "@/lib/onboarding/access";
import { computeProgress } from "@/lib/onboarding/phases";
import { loadUiGuideTexts } from "@/lib/onboarding/uiGuideTexts";
import { ActionWithGuide } from "@/components/onboarding/ActionGuide";
import { EmptyState, InlineError } from "@/components/ui/states";

export default async function AdminDashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ customer?: string }>;
}) {
  const ctx = await requireAdminAccess();
  const sp = await searchParams;
  const guides = await loadUiGuideTexts([
    "admin.dashboard.setup",
    "admin.dashboard.checklist",
  ]);
  const supabase = await createClient();

  let customersQuery = supabase
    .from("customers")
    .select("id, name, slug, status, description")
    .order("created_at", { ascending: false });

  if (!ctx.isPlatformAdmin) {
    const ids = ctx.memberships
      .filter((m) => m.role === "customer_admin")
      .map((m) => m.customer_id);
    const fallback = primaryCustomerId(ctx);
    const filterIds = ids.length ? ids : fallback ? [fallback] : [];
    customersQuery = customersQuery.in(
      "id",
      filterIds.length ? filterIds : ["00000000-0000-0000-0000-000000000000"],
    );
  }

  const { data: customers, error: customersError } = await customersQuery;
  if (customersError) {
    console.error("[admin/dashboard] customers", customersError.message);
    return (
      <div className="space-y-4">
        <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">
          Admin-Dashboard
        </h1>
        <InlineError
          title="Kundendaten nicht ladbar"
          message="Die Kundenliste konnte nicht geladen werden. Bitte später erneut versuchen oder das Setup öffnen."
          actionHref="/admin/setup"
          actionLabel="Zum Setup"
        />
      </div>
    );
  }

  const customerId =
    sp.customer ||
    customers?.[0]?.id ||
    primaryCustomerId(ctx) ||
    undefined;

  let progress = { required: 0, done: 0, open: 0, blocked: 0, percent: 0 };
  let goals: Array<{ title: string }> = [];
  let adapters: Array<{ name: string }> = [];
  let uploads: Array<{
    original_filename: string;
    status: string;
    uploaded_at: string;
  }> = [];
  let runs: Array<{
    pipeline_step_key: string;
    status: string;
    created_at: string;
  }> = [];
  let gates: Array<{ title: string; status: string }> = [];
  let nextStep: { title: string; id: string } | null = null;

  if (customerId) {
    const results = await Promise.all([
      supabase
        .from("customer_workflow_steps")
        .select("id, title, required, completed, status, sort_order")
        .eq("customer_id", customerId)
        .order("sort_order"),
      supabase
        .from("project_goals")
        .select("title")
        .eq("customer_id", customerId)
        .eq("selected", true),
      supabase
        .from("customer_input_adapters")
        .select("input_adapters(name)")
        .eq("customer_id", customerId),
      supabase
        .from("source_uploads")
        .select("original_filename, status, uploaded_at")
        .eq("customer_id", customerId)
        .order("uploaded_at", { ascending: false })
        .limit(5),
      supabase
        .from("pipeline_runs")
        .select("pipeline_step_key, status, created_at")
        .eq("customer_id", customerId)
        .order("created_at", { ascending: false })
        .limit(5),
      supabase
        .from("quality_gates")
        .select("title, status")
        .eq("customer_id", customerId)
        .neq("status", "passed")
        .limit(5),
    ]);

    for (const r of results) {
      if (r.error) {
        console.error("[admin/dashboard] query", r.error.message);
      }
    }

    const [stepsRes, gRes, aRes, uRes, rRes, qRes] = results;
    progress = computeProgress(stepsRes.data ?? []);
    goals = gRes.data ?? [];
    adapters = (aRes.data ?? []).map((row) => {
      const ia = row.input_adapters as
        | { name: string }
        | { name: string }[]
        | null;
      const m = Array.isArray(ia) ? ia[0] : ia;
      return { name: m?.name ?? "—" };
    });
    uploads = uRes.data ?? [];
    runs = rRes.data ?? [];
    gates = qRes.data ?? [];
    nextStep =
      (stepsRes.data ?? []).find((s) => s.status === "ready" && !s.completed) ??
      null;
  }

  return (
    <div className="space-y-4 sm:space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">
            Admin-Dashboard
          </h1>
          <p className="muted mt-1 text-sm">Überblick und nächste Aktion.</p>
        </div>
        <ActionWithGuide guide={guides.get("admin.dashboard.setup")}>
          {ctx.isPlatformAdmin ? (
            <Link href="/admin/setup" className="btn btn-primary">
              Neuen Kunden anlegen
            </Link>
          ) : (
            <Link
              href={`/admin/setup?customer=${customerId ?? ""}`}
              className="btn btn-primary"
            >
              Setup fortsetzen
            </Link>
          )}
        </ActionWithGuide>
      </div>

      {!customerId ? (
        <EmptyState
          title="Noch kein Kunde"
          message="Legen Sie im Setup den ersten Kunden an, um Fortschritt und Fahrplan zu sehen."
          actionHref="/admin/setup"
          actionLabel="Setup starten"
        />
      ) : null}

      {customers && customers.length > 1 ? (
        <div className="panel compact p-3">
          <p className="label mb-2">Kunde</p>
          <div className="flex flex-wrap gap-2">
            {customers.map((c) => (
              <Link
                key={c.id}
                href={`/admin/dashboard?customer=${c.id}`}
                className={`rounded-lg border px-3 py-1.5 text-sm ${
                  c.id === customerId
                    ? "border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]"
                    : "border-[var(--border)]"
                }`}
              >
                {c.name}
              </Link>
            ))}
          </div>
        </div>
      ) : null}

      {customerId ? (
        <>
          <section
            className="panel compact space-y-3 border-[var(--accent)] p-4 sm:p-5"
            style={{ borderWidth: 1 }}
          >
            <p className="text-xs font-semibold tracking-wide text-[var(--accent)]">
              Empfohlene Aktion
            </p>
            {nextStep ? (
              <div className="space-y-3">
                <h2 className="text-lg font-semibold">{nextStep.title}</h2>
                <ActionWithGuide guide={guides.get("admin.dashboard.checklist")}>
                  <Link
                    href={`/admin/checklist?customer=${customerId}`}
                    className="btn btn-primary"
                  >
                    Zum Fahrplan
                  </Link>
                </ActionWithGuide>
              </div>
            ) : (
              <div className="space-y-3">
                <p className="text-sm">
                  Kein bereiter Schritt — Setup starten oder Fahrplan prüfen.
                </p>
                <div className="flex flex-wrap gap-2">
                  <Link
                    href={`/admin/setup?customer=${customerId}`}
                    className="btn btn-primary"
                  >
                    Zum Setup
                  </Link>
                  <Link
                    href={`/admin/checklist?customer=${customerId}`}
                    className="btn btn-secondary"
                  >
                    Fahrplan
                  </Link>
                </div>
              </div>
            )}
          </section>

          <div className="grid gap-3 sm:grid-cols-3">
            <div className="panel compact p-3 sm:p-4">
              <p className="muted text-xs">Fortschritt</p>
              <p className="mt-1 text-2xl font-semibold">{progress.percent}%</p>
              <p className="muted mt-1 text-xs">
                {progress.done}/{progress.required} · {progress.blocked} blockiert
              </p>
            </div>
            <div className="panel compact p-3 sm:p-4">
              <p className="muted text-xs">Ziele</p>
              {goals.length ? (
                <ul className="mt-1 space-y-0.5 text-sm">
                  {goals.map((g) => (
                    <li key={g.title}>{g.title}</li>
                  ))}
                </ul>
              ) : (
                <p className="muted mt-1 text-sm">—</p>
              )}
            </div>
            <div className="panel compact p-3 sm:p-4">
              <p className="muted text-xs">Adapter</p>
              {adapters.length ? (
                <ul className="mt-1 space-y-0.5 text-sm">
                  {adapters.map((a) => (
                    <li key={a.name}>{a.name}</li>
                  ))}
                </ul>
              ) : (
                <p className="muted mt-1 text-sm">—</p>
              )}
            </div>
          </div>

          <div className="grid gap-3 lg:grid-cols-3">
            <section className="panel compact p-3 sm:p-4">
              <h2 className="text-sm font-semibold">Uploads</h2>
              {uploads.length ? (
                <ul className="mt-2 space-y-1.5 text-sm">
                  {uploads.map((u) => (
                    <li key={`${u.original_filename}-${u.uploaded_at}`}>
                      <span className="break-words">{u.original_filename}</span>{" "}
                      <span className="muted">({u.status})</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted mt-2 text-sm">Keine</p>
              )}
            </section>
            <section className="panel compact p-3 sm:p-4">
              <h2 className="text-sm font-semibold">Pipeline-Runs</h2>
              {runs.length ? (
                <ul className="mt-2 space-y-1.5 text-sm">
                  {runs.map((r, i) => (
                    <li key={`${r.pipeline_step_key}-${i}`}>
                      {r.pipeline_step_key}{" "}
                      <span className="muted">({r.status})</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted mt-2 text-sm">Keine</p>
              )}
            </section>
            <section className="panel compact p-3 sm:p-4">
              <h2 className="text-sm font-semibold">Qualität</h2>
              {gates.length ? (
                <ul className="mt-2 space-y-1.5 text-sm">
                  {gates.map((g) => (
                    <li key={g.title}>
                      {g.title} <span className="muted">({g.status})</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted mt-2 text-sm">Keine offenen Gates</p>
              )}
            </section>
          </div>
        </>
      ) : null}
    </div>
  );
}
