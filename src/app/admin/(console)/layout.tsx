import { requireAdminAccess } from "@/lib/onboarding/access";
import { AdminShell } from "@/components/onboarding/AdminShell";

export default async function AdminConsoleLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const ctx = await requireAdminAccess();

  return (
    <AdminShell
      email={ctx.email}
      roleLabel={ctx.roleLabel}
      agentTitle={ctx.agentTitle}
      logoUrl={ctx.customerLogoUrl}
      customerName={ctx.customerName}
    >
      {!ctx.schemaReady ? (
        <div
          className="panel compact mb-4 p-3 text-sm"
          style={{ background: "var(--accent-soft)" }}
        >
          <p className="font-semibold">Onboarding-Daten eingeschränkt</p>
          <p className="muted mt-1">
            Einige Tabellen sind noch nicht vollständig verfügbar. Die Navigation
            bleibt nutzbar.
          </p>
        </div>
      ) : null}
      {children}
    </AdminShell>
  );
}
