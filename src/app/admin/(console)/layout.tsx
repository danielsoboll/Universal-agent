import { requireProjectConsoleAccess } from "@/lib/onboarding/access";
import { resolveShellBranding } from "@/lib/onboarding/projectBranding";
import { AdminShell } from "@/components/onboarding/AdminShell";

export default async function AdminConsoleLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const ctx = await requireProjectConsoleAccess();
  const branding = resolveShellBranding({
    isGeneralAdmin: ctx.isGeneralAdmin || ctx.isPlatformAdmin,
    customerName: ctx.customerName,
    customerLogoUrl: ctx.customerLogoUrl,
    fallbackTitle: ctx.agentTitle,
  });

  return (
    <AdminShell
      email={ctx.email}
      agentTitle={branding.title}
      logoUrl={branding.logoUrl}
      customerName={ctx.customerName}
      productModule={ctx.productModule}
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
