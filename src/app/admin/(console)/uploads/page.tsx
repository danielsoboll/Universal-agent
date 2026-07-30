import { createClient } from "@/lib/supabase/server";
import { requireAdminAccess } from "@/lib/onboarding/access";

export default async function AdminUploadsPage({
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
    .from("source_uploads")
    .select("*")
    .eq("customer_id", customerId)
    .order("uploaded_at", { ascending: false })
    .limit(50);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Uploads</h1>
        <p className="muted mt-1 text-sm">
          Speicherpfade sind mandantengetrennt (<code>{customerId}/…</code>).
          Upload-UI mit Storage folgt; Metadaten bereits modelliert.
        </p>
      </div>
      <div className="space-y-3">
        {(data ?? []).map((u) => (
          <article key={u.id} className="panel p-4 text-sm">
            <p className="font-semibold">{u.original_filename}</p>
            <p className="muted mt-1">
              {u.adapter_key} · {u.status} · {u.storage_path}
            </p>
          </article>
        ))}
        {!data?.length ? (
          <div className="panel p-6 muted">Noch keine Uploads vorhanden.</div>
        ) : null}
      </div>
    </div>
  );
}
