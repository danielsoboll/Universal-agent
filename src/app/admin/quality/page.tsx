import { createClient } from "@/lib/supabase/server";
import { requireAdminAccess } from "@/lib/onboarding/access";

export default async function AdminQualityPage({
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
  const { data } = await supabase
    .from("quality_gates")
    .select("*")
    .eq("customer_id", customerId)
    .order("created_at", { ascending: false });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Qualität</h1>
        <p className="muted mt-1 text-sm">
          Quality Gates und Freigaben. Auswertung lokaler Reports bleibt angebunden an
          bestehende CLI-Artefakte — ohne Neuanalyse.
        </p>
      </div>
      <div className="space-y-3">
        {(data ?? []).map((g) => (
          <article key={g.id} className="panel p-4">
            <p className="font-semibold">{g.title}</p>
            <p className="muted mt-1 text-sm">
              {g.gate_key} · {g.status}
            </p>
          </article>
        ))}
        {!data?.length ? (
          <div className="panel p-6 muted">Noch keine Quality Gates erfasst.</div>
        ) : null}
      </div>
    </div>
  );
}
