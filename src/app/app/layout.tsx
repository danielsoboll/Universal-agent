import { createClient } from "@/lib/supabase/server";
import {
  primaryCustomerId,
  requireAppAccess,
} from "@/lib/onboarding/access";
import { AppShell } from "@/components/onboarding/AppShell";

export default async function AppAreaLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const ctx = await requireAppAccess();
  const customerId = primaryCustomerId(ctx);
  let released = ctx.isPlatformAdmin;

  if (customerId && !released) {
    const supabase = await createClient();
    const { data: customer } = await supabase
      .from("customers")
      .select("status")
      .eq("id", customerId)
      .maybeSingle();
    released = customer?.status === "active";

    // Also treat release step completed as release signal
    if (!released) {
      const { data: releaseStep } = await supabase
        .from("customer_workflow_steps")
        .select("completed")
        .eq("customer_id", customerId)
        .eq("completed", true)
        .ilike("step_key", "%release%")
        .limit(1)
        .maybeSingle();
      released = Boolean(releaseStep);
    }
  }

  return (
    <AppShell email={ctx.email} released={released}>
      {children}
    </AppShell>
  );
}
