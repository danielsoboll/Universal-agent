import { createClient } from "@/lib/supabase/server";
import {
  primaryCustomerId,
  requireAdminAccess,
} from "@/lib/onboarding/access";
import { EmptyState } from "@/components/ui/states";

export default async function AdminQualityPage({
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
        message="Bitte zuerst einen Kunden im Setup anlegen."
        actionHref="/admin/setup"
        actionLabel="Zum Setup"
      />
    );
  }
  await requireAdminAccess(customerId);
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("quality_gates")
    .select("*")
    .eq("customer_id", customerId)
    .order("created_at", { ascending: false });

  if (error) console.error("[admin/quality]", error.message);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold sm:text-2xl">Qualität</h1>
        <p className="muted mt-1 text-sm">
          Quality Gates und Freigaben — ohne Neuanalyse.
        </p>
      </div>
      <div className="space-y-2">
        {(data ?? []).map((g) => (
          <article key={g.id} className="panel compact p-3">
            <p className="font-semibold">{g.title}</p>
            <p className="muted mt-1 text-sm">
              {g.gate_key} · {g.status}
            </p>
          </article>
        ))}
        {!data?.length ? (
          <EmptyState
            title="Keine Quality Gates"
            message="Gates erscheinen, sobald die Pipeline sie erfasst."
          />
        ) : null}
      </div>
    </div>
  );
}
