import { requireAdminAccess } from "@/lib/onboarding/access";
import { AdminShell } from "@/components/onboarding/AdminShell";

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const ctx = await requireAdminAccess();
  const roleLabel = ctx.isPlatformAdmin
    ? "Platform Admin"
    : "Customer Admin";

  return (
    <AdminShell email={ctx.email} roleLabel={roleLabel}>
      {children}
    </AdminShell>
  );
}
