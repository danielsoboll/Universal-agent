import { createClient } from "@/lib/supabase/server";
import {
  primaryCustomerId,
  requireAdminAccess,
} from "@/lib/onboarding/access";
import { inviteCustomerUserAction } from "@/actions/onboarding";
import { loadUiGuideTexts } from "@/lib/onboarding/uiGuideTexts";
import { FormSubmitButton } from "@/components/ui/FormSubmitButton";
import { SectionTitleWithInfo } from "@/components/ui/SectionTitleWithInfo";
import { EmptyState } from "@/components/ui/states";
import { createAdminClient } from "@/lib/supabase/admin";

export default async function AdminUsersPage({
  searchParams,
}: {
  searchParams: Promise<{ customer?: string; invited?: string }>;
}) {
  const ctx = await requireAdminAccess();
  const sp = await searchParams;
  const guides = await loadUiGuideTexts(["admin.users.invite"]);
  const customerId = sp.customer || primaryCustomerId(ctx) || undefined;
  if (!customerId) {
    return (
      <EmptyState
        title="Kein Projekt ausgewählt"
        message="Bitte zuerst ein Projekt im Setup anlegen"
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

  const emailByUserId = new Map<string, string>();
  try {
    const admin = createAdminClient();
    const listed = await admin.auth.admin.listUsers({ perPage: 1000 });
    for (const u of listed.data?.users ?? []) {
      if (u.email) emailByUserId.set(u.id, u.email);
    }
  } catch {
    /* Service-Role optional für Anzeige */
  }

  return (
    <div className="space-y-4">
      <SectionTitleWithInfo
        as="h1"
        title="Anwender"
        guide={guides.get("admin.users.invite")}
        infoTitle="Anwender anlegen"
      />

      {sp.invited ? (
        <div
          className="panel compact p-3 text-sm"
          style={{ background: "var(--accent-soft)" }}
        >
          Anwender wurde dem Projekt zugeordnet. Das gesetzte Passwort gilt
          sofort für den Login.
        </div>
      ) : null}

      <form
        action={inviteCustomerUserAction}
        className="panel compact grid gap-3 p-4 md:grid-cols-2"
      >
        <input type="hidden" name="customer_id" value={customerId} />
        <div>
          <label className="label" htmlFor="email">
            E-Mail
          </label>
          <input
            className="input"
            id="email"
            name="email"
            type="email"
            required
            autoComplete="off"
            placeholder="anwender@firma.de"
          />
        </div>
        <div>
          <label className="label" htmlFor="display_name">
            Anzeigename
          </label>
          <input
            className="input"
            id="display_name"
            name="display_name"
            autoComplete="off"
            placeholder="Optional"
          />
        </div>
        <div>
          <label className="label" htmlFor="password">
            Passwort (Klarschrift)
          </label>
          <input
            className="input font-mono"
            id="password"
            name="password"
            type="text"
            required
            minLength={8}
            autoComplete="new-password"
            placeholder="z. B. Willkommen-2026!"
          />
        </div>
        <div>
          <label className="label" htmlFor="role">
            Rolle
          </label>
          <select
            className="input"
            id="role"
            name="role"
            defaultValue="customer_user"
          >
            <option value="customer_user">
              Projekt-Benutzer (nur lesen in den 6 Schritten)
            </option>
            <option value="customer_admin">
              Projekt-Admin (alle Aktionen im Projekt)
            </option>
          </select>
        </div>
        <div className="md:col-span-2">
          <FormSubmitButton pendingLabel="Wird angelegt …">
            Anwender anlegen
          </FormSubmitButton>
        </div>
      </form>

      <div className="space-y-2">
        {(data ?? []).map((m) => (
          <article key={m.id} className="panel compact p-3 text-sm">
            <p className="font-medium">
              {emailByUserId.get(m.user_id) ?? m.user_id}
            </p>
            <p className="muted mt-1 text-xs">
              {m.role === "customer_admin"
                ? "Projekt-Admin"
                : "Projekt-Benutzer"}{" "}
              · {m.status}
            </p>
          </article>
        ))}
        {!data?.length ? (
          <EmptyState
            title="Keine Anwender"
            message="Legen Sie oben den ersten Projekt-Anwender an"
          />
        ) : null}
      </div>
    </div>
  );
}
