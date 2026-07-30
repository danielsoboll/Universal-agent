import { createClient } from "@/lib/supabase/server";
import {
  primaryCustomerId,
  requireAdminAccess,
} from "@/lib/onboarding/access";
import { inviteCustomerUserAction } from "@/actions/onboarding";
import { loadUiGuideTexts } from "@/lib/onboarding/uiGuideTexts";
import { ActionWithGuide } from "@/components/onboarding/ActionGuide";
import { FormSubmitButton } from "@/components/ui/FormSubmitButton";
import { EmptyState } from "@/components/ui/states";

export default async function AdminUsersPage({
  searchParams,
}: {
  searchParams: Promise<{ customer?: string }>;
}) {
  const ctx = await requireAdminAccess();
  const sp = await searchParams;
  const guides = await loadUiGuideTexts(["admin.users.invite"]);
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
    .from("customer_memberships")
    .select("id, user_id, role, status, created_at")
    .eq("customer_id", customerId)
    .order("created_at");

  if (error) console.error("[admin/users]", error.message);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold sm:text-2xl">Benutzer</h1>
        <p className="muted mt-1 text-sm">
          Customer User nutzen nur den Anwenderbereich. V1 verknüpft bestehende
          Auth-User-IDs.
        </p>
      </div>

      <form
        action={inviteCustomerUserAction}
        className="panel compact grid gap-3 p-4 md:grid-cols-2"
      >
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
        <div className="md:col-span-2">
          <ActionWithGuide guide={guides.get("admin.users.invite")}>
            <FormSubmitButton pendingLabel="Speichern …">
              Mitgliedschaft speichern
            </FormSubmitButton>
          </ActionWithGuide>
        </div>
      </form>

      <div className="space-y-2">
        {(data ?? []).map((m) => (
          <article key={m.id} className="panel compact p-3 text-sm">
            <p className="break-all font-mono text-xs">{m.user_id}</p>
            <p className="mt-1">
              {m.role} · {m.status}
            </p>
          </article>
        ))}
        {!data?.length ? (
          <EmptyState
            title="Keine Mitgliedschaften"
            message="Legen Sie oben die erste Mitgliedschaft an."
          />
        ) : null}
      </div>
    </div>
  );
}
