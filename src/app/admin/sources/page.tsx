import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requireAdminAccess } from "@/lib/onboarding/access";

export default async function AdminSourcesPage({
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
    .from("customer_input_adapters")
    .select("status, configuration, input_adapters(name, adapter_key, availability_status)")
    .eq("customer_id", customerId);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Quellen & Adapter</h1>
        <Link href={`/admin/setup?customer=${customerId}&step=3`} className="btn btn-secondary">
          Im Setup bearbeiten
        </Link>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        {(data ?? []).map((row, i) => {
          const raw = row.input_adapters as unknown;
          const ia = (Array.isArray(raw) ? raw[0] : raw) as {
            name: string;
            adapter_key: string;
            availability_status: string;
          } | null;
          return (
            <article key={i} className="panel p-4">
              <h2 className="font-semibold">{ia?.name ?? "Adapter"}</h2>
              <p className="mt-1 text-sm muted">{ia?.adapter_key}</p>
              <p className="mt-2 text-sm">Status: {row.status}</p>
              <pre className="mt-3 overflow-auto rounded-lg bg-[#f7f9fb] p-3 text-xs">
                {JSON.stringify(row.configuration ?? {}, null, 2)}
              </pre>
            </article>
          );
        })}
        {!data?.length ? (
          <p className="muted">Noch keine Adapter ausgewählt.</p>
        ) : null}
      </div>
    </div>
  );
}
