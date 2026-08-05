import Link from "next/link";
import {
  canMutateProjectSetup,
  primaryCustomerId,
  requireAdminAccess,
} from "@/lib/onboarding/access";
import { createClient } from "@/lib/supabase/server";
import { applyCustomerScopeFilter } from "@/lib/onboarding/customerQuery";
import { DeleteCustomerForm } from "@/components/onboarding/DeleteCustomerForm";
import { EmptyState, InlineError } from "@/components/ui/states";
import { PressNavigateLink } from "@/components/ui/PressNavigateLink";

export default async function AdminProjectAdministrationPage({
  searchParams,
}: {
  searchParams: Promise<{ customer?: string; error?: string }>;
}) {
  const ctx = await requireAdminAccess();
  const sp = await searchParams;
  const supabase = await createClient();
  const isGeneralAdmin = ctx.isGeneralAdmin || ctx.isPlatformAdmin;
  const canMutate = canMutateProjectSetup(ctx);

  let customersQuery = supabase
    .from("customers")
    .select("id, name, slug, status")
    .order("created_at", { ascending: false });
  customersQuery = applyCustomerScopeFilter(customersQuery, ctx);
  const { data: customers, error: customersError } = await customersQuery;

  if (customersError) {
    console.error("[admin/project] customers", customersError.message);
    return (
      <div className="space-y-3">
        <h1 className="text-[1.5rem] font-semibold tracking-tight sm:text-[1.75rem]">
          Projekt-Administration
        </h1>
        <InlineError
          title="Projekt nicht ladbar"
          message="Die Projektdaten konnten nicht geladen werden"
        />
      </div>
    );
  }

  const customerId =
    sp.customer ||
    customers?.[0]?.id ||
    primaryCustomerId(ctx) ||
    undefined;
  const selectedCustomer = customers?.find((c) => c.id === customerId) ?? null;
  const customerQs = customerId ? `?customer=${customerId}` : "";

  if (!customerId || !selectedCustomer) {
    return (
      <div className="space-y-3">
        <h1 className="text-[1.5rem] font-semibold tracking-tight sm:text-[1.75rem]">
          Projekt-Administration
        </h1>
        <EmptyState
          title="Kein Projekt ausgewählt"
          message="Bitte zuerst ein Projekt im Dashboard wählen oder anlegen"
          actionHref="/admin/dashboard"
          actionLabel="Zum Dashboard"
        />
      </div>
    );
  }

  await requireAdminAccess(customerId);

  return (
    <div className="space-y-3">
      <h1 className="text-[1.5rem] font-semibold tracking-tight sm:text-[1.75rem]">
        Projekt-Administration
      </h1>
      <p className="text-[0.9375rem] text-[var(--muted)]">
        {selectedCustomer.name}
        {selectedCustomer.slug ? (
          <>
            {" "}
            <span className="font-mono text-[0.8125rem]">
              ({selectedCustomer.slug})
            </span>
          </>
        ) : null}
      </p>

      {sp.error ? (
        <InlineError title="Aktion fehlgeschlagen" message={sp.error} />
      ) : null}

      <section className="admin-card space-y-2 rounded-[12px] border border-[var(--border)] bg-[var(--panel)] p-3">
        <p className="text-[0.875rem] font-medium text-[var(--muted)]">
          Benutzer &amp; Anwender
        </p>
        {canMutate ? (
          <PressNavigateLink
            href={`/admin/users${customerQs}`}
            className="btn btn-secondary flex min-h-12 w-full items-center justify-center text-[1.0625rem]"
          >
            Benutzer anlegen
          </PressNavigateLink>
        ) : null}
        <Link
          href="/app"
          className="btn btn-secondary flex min-h-12 w-full items-center justify-center text-[1.0625rem]"
        >
          Anwenderbereich
        </Link>
      </section>

      {isGeneralAdmin ? (
        <section className="admin-card space-y-2 rounded-[12px] border border-[var(--border)] bg-[var(--panel)] p-3">
          <p className="text-[0.875rem] font-medium text-[var(--muted)]">
            Projekt löschen
          </p>
          <DeleteCustomerForm
            customerId={selectedCustomer.id}
            customerName={selectedCustomer.name}
            customerSlug={selectedCustomer.slug}
          />
        </section>
      ) : null}
    </div>
  );
}
