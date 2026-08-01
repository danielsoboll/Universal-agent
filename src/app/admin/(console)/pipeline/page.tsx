import { createClient } from "@/lib/supabase/server";
import {
  primaryCustomerId,
  requireAdminAccess,
} from "@/lib/onboarding/access";
import { listPipelineSteps } from "@/lib/core/pipelineRegistry";
import { EmptyState } from "@/components/ui/states";

export default async function AdminPipelinePage({
  searchParams,
}: {
  searchParams: Promise<{ customer?: string }>;
}) {
  const ctx = await requireAdminAccess();
  const sp = await searchParams;
  const customerId = sp.customer || primaryCustomerId(ctx) || undefined;
  if (!customerId) {
    return (
      <EmptyState
        title="Kein Kunde ausgewählt"
        message="Bitte zuerst einen Kunden im Setup anlegen"
        actionHref="/admin/setup"
        actionLabel="Zum Setup"
      />
    );
  }
  await requireAdminAccess(customerId);
  const supabase = await createClient();
  const { data: runs, error } = await supabase
    .from("pipeline_runs")
    .select("*")
    .eq("customer_id", customerId)
    .order("created_at", { ascending: false })
    .limit(30);

  if (error) console.error("[admin/pipeline]", error.message);

  const registry = listPipelineSteps({ includeReserved: true });

  return (
    <div className="space-y-4">
      <div>
        <h1 className="admin-page-title">Pipeline</h1>
      </div>

      <section className="panel compact p-4">
        <h2 className="text-sm font-semibold">Registry</h2>
        <ul className="mt-2 space-y-1.5 text-sm">
          {registry.map((s) => (
            <li key={s.id}>
              <code>{s.id}</code> — {s.title}{" "}
              <span className="muted">({s.status})</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">Runs</h2>
        {(runs ?? []).map((r) => (
          <article key={r.id} className="panel compact p-3 text-sm">
            <p className="font-semibold">{r.pipeline_step_key}</p>
            <p className="muted mt-1">
              Status: {r.status}
              {r.estimated_cost != null ? ` · Kosten ~ ${r.estimated_cost}` : ""}
            </p>
            {r.input_summary ? (
              <pre className="mt-2 overflow-auto rounded-lg bg-[var(--surface-raised)] p-2 text-xs">
                {JSON.stringify(r.input_summary, null, 2)}
              </pre>
            ) : null}
          </article>
        ))}
        {!runs?.length ? (
          <EmptyState
            title="Keine Runs"
            message="Pipeline-Runs erscheinen, sobald Schritte aus dem Fahrplan gestartet werden"
          />
        ) : null}
      </section>
    </div>
  );
}
