import { requireLocalAdmin } from "@/lib/localAuth/session";
import { LocalAdminShell } from "@/components/local/LocalAdminShell";

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const ctx = await requireLocalAdmin();
  return <LocalAdminShell email={ctx.user.email}>{children}</LocalAdminShell>;
}
