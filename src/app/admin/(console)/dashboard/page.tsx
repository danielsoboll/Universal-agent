import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requireAdminAccess } from "@/lib/onboarding/access";
import { computeProgress } from "@/lib/onboarding/phases";
import { loadUiGuideTexts } from "@/lib/onboarding/uiGuideTexts";
import { ActionWithGuide } from "@/components/onboarding/ActionGuide";

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
    customersQuery = customersQuery.in("id", ids.length ? ids : ["00000000-0000-0000-0000-000000000000"]);
  }

  const { data: customers, error: customersError } = await customersQuery;
  if (customersError) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-semibold tracking-tight">Admin-Dashboard</h1>
        <div className="panel p-6 text-sm">
          <p className="font-semibold">Kundendaten nicht ladbar</p>
          <p className="muted mt-2">
            {customersError.message}. Wenn die Onboarding-Migrationen noch fehlen,
            bitte zuerst anwenden — danach den ersten Login erneut laden (Bootstrap
            als Platform Admin).
          </p>
          <Link href="/admin/setup" className="btn btn-primary mt-4 inline-flex">
            Zum Setup
          </Link>
        </div>
      </div>
    );
  }
  const customerId =
    sp.customer ||
    customers?.[0]?.id ||
    ctx.memberships.find((m) => m.role === "customer_admin")?.customer_id;

  let progress = { required: 0, done: 0, open: 0, blocked: 0, percent: 0 };
  let goals: Array<{ title: string }> = [];
  let adapters: Array<{ name: string }> = [];
  let uploads: Array<{ original_filename: string; status: string; uploaded_at: string }> = [];
  let runs: Array<{ pipeline_step_key: string; status: string; created_at: string }> = [];
  let gates: Array<{ title: string; status: string }> = [];
  let nextStep: { title: string; id: string } | null = null;

  if (customerId) {
    const [
      { data: steps },
      { data: g },
      { data: a },
      { data: u },
      { data: r },
      { data: q },
    ] = await Promise.all([
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

    progress = computeProgress(steps ?? []);
    goals = g ?? [];
    adapters = (a ?? []).map((row) => {
      const ia = row.input_adapters as { name: string } | { name: string }[] | null;
      const m = Array.isArray(ia) ? ia[0] : ia;
      return { name: m?.name ?? "—" };
    });
    uploads = u ?? [];
    runs = r ?? [];
    gates = q ?? [];
    nextStep =
      (steps ?? []).find((s) => s.status === "ready" && !s.completed) ?? null;
  }

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Admin-Dashboard</h1>
          <p className="muted mt-1">
            Überblick über Onboarding, Qualität und nächste Schritte.
          </p>
        </div>
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

      {customers && customers.length > 1 ? (
        <div className="panel p-4">
          <p className="label">Kunde</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {customers.map((c) => (
              <Link
                key={c.id}
                href={`/admin/dashboard?customer=${c.id}`}
                className={`rounded-lg border px-3 py-1.5 text-sm ${
                  c.id === customerId
                    ? "border-[var(--accent)] bg-[#e8f3ef]"
                    : "border-[var(--border)]"
                }`}
              >
                {c.name}
              </Link>
            ))}
          </div>
        </div>
      ) : null}

      <div className="grid gap-4 md:grid-cols-3">
        <div className="panel p-5">
          <p className="text-sm muted">Fortschritt (erforderlich)</p>
          <p className="mt-2 text-3xl font-semibold">{progress.percent}%</p>
          <p className="mt-1 text-sm muted">
            {progress.done}/{progress.required} abgeschlossen · {progress.blocked}{" "}
            blockiert
          </p>
        </div>
        <div className="panel p-5">
          <p className="text-sm muted">Ziele</p>
          <ul className="mt-2 space-y-1 text-sm">
            {goals.length ? goals.map((g) => <li key={g.title}>{g.title}</li>) : <li className="muted">Noch keine</li>}
          </ul>
        </div>
        <div className="panel p-5">
          <p className="text-sm muted">Aktive Adapter</p>
          <ul className="mt-2 space-y-1 text-sm">
            {adapters.length ? adapters.map((a) => <li key={a.name}>{a.name}</li>) : <li className="muted">Noch keine</li>}
          </ul>
        </div>
      </div>

      <div className="panel p-5">
        <p className="font-semibold">Nächste empfohlene Aktion</p>
        {nextStep ? (
          <div className="mt-3 space-y-3">
            <p>{nextStep.title}</p>
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
          <p className="muted mt-2 text-sm">
            Kein bereiter Schritt — Setup starten oder Fahrplan prüfen.
          </p>
        )}
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <section className="panel p-5">
          <h2 className="font-semibold">Letzte Uploads</h2>
          <ul className="mt-3 space-y-2 text-sm">
            {uploads.length ? (
              uploads.map((u) => (
                <li key={`${u.original_filename}-${u.uploaded_at}`}>
                  {u.original_filename}{" "}
                  <span className="muted">({u.status})</span>
                </li>
              ))
            ) : (
              <li className="muted">Keine Uploads</li>
            )}
          </ul>
        </section>
        <section className="panel p-5">
          <h2 className="font-semibold">Pipeline-Runs</h2>
          <ul className="mt-3 space-y-2 text-sm">
            {runs.length ? (
              runs.map((r, i) => (
                <li key={`${r.pipeline_step_key}-${i}`}>
                  {r.pipeline_step_key}{" "}
                  <span className="muted">({r.status})</span>
                </li>
              ))
            ) : (
              <li className="muted">Keine Runs</li>
            )}
          </ul>
        </section>
        <section className="panel p-5">
          <h2 className="font-semibold">Offene Qualitätsprobleme</h2>
          <ul className="mt-3 space-y-2 text-sm">
            {gates.length ? (
              gates.map((g) => (
                <li key={g.title}>
                  {g.title} <span className="muted">({g.status})</span>
                </li>
              ))
            ) : (
              <li className="muted">Keine offenen Gates</li>
            )}
          </ul>
          <p className="muted mt-3 text-xs">
            Kosten/Token erscheinen, sobald Pipeline-Runs sie liefern.
          </p>
        </section>
      </div>
    </div>
  );
}
