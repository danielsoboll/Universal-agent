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
  let released = ctx.isPlatformAdmin || ctx.isGeneralAdmin;

  if (customerId && !released) {
    try {
      const supabase = await createClient();
      const { data: customer } = await supabase
        .from("customers")
        .select("status")
        .eq("id", customerId)
        .maybeSingle();
      released = customer?.status === "active";

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
    } catch (error) {
      console.error("[app-layout] release check failed", error);
      released = false;
    }
  }

  return (
    <AppShell
      email={ctx.email}
      released={released}
      agentTitle={ctx.agentTitle}
      logoUrl={ctx.customerLogoUrl}
    >
      {children}
    </AppShell>
  );
}
