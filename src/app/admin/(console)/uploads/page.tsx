import { createClient } from "@/lib/supabase/server";
import {
  primaryCustomerId,
  requireAdminAccess,
} from "@/lib/onboarding/access";
import { EmptyState } from "@/components/ui/states";

export default async function AdminUploadsPage({
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
    .from("source_uploads")
    .select("*")
    .eq("customer_id", customerId)
    .order("uploaded_at", { ascending: false })
    .limit(50);

  if (error) console.error("[admin/uploads]", error.message);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="admin-page-title">Uploads</h1>
      </div>
      <div className="space-y-2">
        {(data ?? []).map((u) => (
          <article key={u.id} className="panel compact p-3 text-sm">
            <p className="break-words font-semibold">{u.original_filename}</p>
            <p className="muted mt-1 break-all">
              {u.adapter_key} · {u.status} · {u.storage_path}
            </p>
          </article>
        ))}
        {!data?.length ? (
          <EmptyState
            title="Keine Uploads"
            message="Sobald Dateien hochgeladen werden, erscheinen sie hier"
          />
        ) : null}
      </div>
    </div>
  );
}
