import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import {
  primaryCustomerId,
  requireAdminAccess,
} from "@/lib/onboarding/access";
import { EmptyState } from "@/components/ui/states";

export default async function AdminSourcesPage({
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
  const { data, error } = await supabase
    .from("customer_input_adapters")
    .select("status, configuration, input_adapters(name, adapter_key, availability_status)")
    .eq("customer_id", customerId);

  if (error) {
    console.error("[admin/sources]", error.message);
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="admin-page-title">Quellen & Adapter</h1>
        <Link
          href={`/admin/setup?customer=${customerId}&step=3`}
          className="btn btn-secondary"
        >
          Im Setup bearbeiten
        </Link>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        {(data ?? []).map((row, i) => {
          const raw = row.input_adapters as unknown;
          const ia = (Array.isArray(raw) ? raw[0] : raw) as {
            name: string;
            adapter_key: string;
            availability_status: string;
          } | null;
          return (
            <article key={i} className="panel compact p-4">
              <h2 className="font-semibold">{ia?.name ?? "Adapter"}</h2>
              <p className="muted mt-1 text-sm">{ia?.adapter_key}</p>
              <p className="mt-2 text-sm">Status: {row.status}</p>
              <pre className="mt-3 overflow-auto rounded-lg bg-[var(--surface-raised)] p-3 text-xs">
                {JSON.stringify(row.configuration ?? {}, null, 2)}
              </pre>
            </article>
          );
        })}
      </div>
      {!data?.length ? (
        <EmptyState
          title="Noch keine Adapter"
          message="Wählen Sie Adapter im Setup aus"
          actionHref={`/admin/setup?customer=${customerId}&step=3`}
          actionLabel="Zum Setup"
        />
      ) : null}
    </div>
  );
}
