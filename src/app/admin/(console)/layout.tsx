import { requireAdminAccess } from "@/lib/onboarding/access";
import { AdminShell } from "@/components/onboarding/AdminShell";

export default async function AdminConsoleLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const ctx = await requireAdminAccess();
  const roleLabel = ctx.roleLabel;

  return (
    <AdminShell email={ctx.email} roleLabel={roleLabel}>
      {!ctx.schemaReady ? (
        <div
          className="panel mb-6 p-4 text-sm"
          style={{ background: "var(--accent-soft)" }}
        >
          <p className="font-semibold">Onboarding-Schema fehlt</p>
          <p className="muted mt-1">
            Migrationen unter <code>supabase/migrations/20260731*</code> noch nicht
            angewendet — Dashboard-Daten können leer oder fehlerhaft sein.
          </p>
        </div>
      ) : null}
      {children}
    </AdminShell>
  );
}
