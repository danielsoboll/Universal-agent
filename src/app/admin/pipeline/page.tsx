import { createClient } from "@/lib/supabase/server";
import { requireAdminAccess } from "@/lib/onboarding/access";
import { listPipelineSteps } from "@/lib/core/pipelineRegistry";

export default async function AdminPipelinePage({
  searchParams,
}: {
  searchParams: Promise<{ customer?: string }>;
}) {
  const ctx = await requireAdminAccess();
  const sp = await searchParams;
  const customerId =
    sp.customer ||
    ctx.memberships.find((m) => m.role === "customer_admin")?.customer_id;
  if (!customerId) {
    return <div className="panel p-6">Kein Kunde ausgewählt.</div>;
  }
  await requireAdminAccess(customerId);
  const supabase = await createClient();
  const { data: runs } = await supabase
    .from("pipeline_runs")
    .select("*")
    .eq("customer_id", customerId)
    .order("created_at", { ascending: false })
    .limit(30);

  const registry = listPipelineSteps({ includeReserved: true });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Pipeline</h1>
        <p className="muted mt-1 text-sm">
          Runs werden serverseitig angelegt. Ohne realen Worker bleiben sie auf{" "}
          <strong>ready/configured</strong> — kein erfundener Erfolg.
        </p>
      </div>

      <section className="panel p-5">
        <h2 className="font-semibold">Registry (lokal)</h2>
        <ul className="mt-3 space-y-2 text-sm">
          {registry.map((s) => (
            <li key={s.id}>
              <code>{s.id}</code> — {s.title}{" "}
              <span className="muted">({s.status})</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="space-y-3">
        <h2 className="font-semibold">Runs dieses Kunden</h2>
        {(runs ?? []).map((r) => (
          <article key={r.id} className="panel p-4 text-sm">
            <p className="font-semibold">{r.pipeline_step_key}</p>
            <p className="muted mt-1">
              Status: {r.status}
              {r.estimated_cost != null ? ` · Kosten ~ ${r.estimated_cost}` : ""}
            </p>
            {r.input_summary ? (
              <pre className="mt-2 overflow-auto rounded bg-[#f7f9fb] p-2 text-xs">
                {JSON.stringify(r.input_summary, null, 2)}
              </pre>
            ) : null}
          </article>
        ))}
        {!runs?.length ? <p className="muted">Noch keine Pipeline-Runs.</p> : null}
      </section>
    </div>
  );
}
