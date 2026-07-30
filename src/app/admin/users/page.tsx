import { createClient } from "@/lib/supabase/server";
import { requireAdminAccess } from "@/lib/onboarding/access";
import { inviteCustomerUserAction } from "@/actions/onboarding";

export default async function AdminUsersPage({
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
    .from("customer_memberships")
    .select("id, user_id, role, status, created_at")
    .eq("customer_id", customerId)
    .order("created_at");

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Benutzer</h1>
        <p className="muted mt-1 text-sm">
          Customer User dürfen nur den Anwenderbereich nutzen. Einladungen per E-Mail
          folgen; V1 verknüpft bestehende Auth-User-IDs.
        </p>
      </div>

      <form action={inviteCustomerUserAction} className="panel grid gap-3 p-5 md:grid-cols-2">
        <input type="hidden" name="customer_id" value={customerId} />
        <div>
          <label className="label" htmlFor="email">
            E-Mail (Notiz)
          </label>
          <input className="input" id="email" name="email" type="email" required />
        </div>
        <div>
          <label className="label" htmlFor="user_id">
            Auth User-ID (UUID)
          </label>
          <input className="input" id="user_id" name="user_id" required />
        </div>
        <div>
          <label className="label" htmlFor="role">
            Rolle
          </label>
          <select className="input" id="role" name="role" defaultValue="customer_user">
            <option value="customer_user">Customer User</option>
            <option value="customer_admin">Customer Admin</option>
          </select>
        </div>
        <div className="flex items-end">
          <button type="submit" className="btn btn-primary">
            Mitgliedschaft speichern
          </button>
        </div>
      </form>

      <div className="space-y-2">
        {(data ?? []).map((m) => (
          <article key={m.id} className="panel p-4 text-sm">
            <p className="font-mono text-xs">{m.user_id}</p>
            <p className="mt-1">
              {m.role} · {m.status}
            </p>
          </article>
        ))}
      </div>
    </div>
  );
}
