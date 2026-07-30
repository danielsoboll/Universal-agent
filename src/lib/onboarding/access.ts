import "server-only";
import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";

export type CustomerMembershipRole = "customer_admin" | "customer_user";

export type AccessContext = {
  userId: string;
  email: string | null;
  isPlatformAdmin: boolean;
  memberships: Array<{
    customer_id: string;
    role: CustomerMembershipRole;
    status: string;
    customer_name: string | null;
    customer_slug: string | null;
  }>;
};

export async function getAccessContext(): Promise<AccessContext | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data: platform } = await supabase
    .from("platform_admins")
    .select("user_id")
    .eq("user_id", user.id)
    .maybeSingle();

  const { data: memberships } = await supabase
    .from("customer_memberships")
    .select(
      "customer_id, role, status, customers(name, slug)",
    )
    .eq("user_id", user.id)
    .eq("status", "active");

  return {
    userId: user.id,
    email: user.email ?? null,
    isPlatformAdmin: Boolean(platform),
    memberships: (memberships ?? []).map((m) => {
      const c = m.customers as
        | { name: string; slug: string }
        | { name: string; slug: string }[]
        | null;
      const customer = Array.isArray(c) ? c[0] : c;
      return {
        customer_id: m.customer_id as string,
        role: m.role as CustomerMembershipRole,
        status: m.status as string,
        customer_name: customer?.name ?? null,
        customer_slug: customer?.slug ?? null,
      };
    }),
  };
}

export function canAccessAdmin(ctx: AccessContext, customerId?: string): boolean {
  if (ctx.isPlatformAdmin) return true;
  if (!customerId) {
    return ctx.memberships.some((m) => m.role === "customer_admin");
  }
  return ctx.memberships.some(
    (m) => m.customer_id === customerId && m.role === "customer_admin",
  );
}

export function canAccessApp(ctx: AccessContext, customerId?: string): boolean {
  if (ctx.isPlatformAdmin) return true;
  if (!customerId) return ctx.memberships.length > 0;
  return ctx.memberships.some((m) => m.customer_id === customerId);
}

export async function requireUser(): Promise<AccessContext> {
  const ctx = await getAccessContext();
  if (!ctx) redirect("/login");
  return ctx;
}

export async function requireAdminAccess(customerId?: string): Promise<AccessContext> {
  const ctx = await requireUser();
  if (!canAccessAdmin(ctx, customerId)) {
    redirect("/app");
  }
  return ctx;
}

export async function requireAppAccess(customerId?: string): Promise<AccessContext> {
  const ctx = await requireUser();
  if (!canAccessApp(ctx, customerId)) {
    redirect("/login");
  }
  // customer_user must not use admin
  return ctx;
}

export function primaryCustomerId(ctx: AccessContext): string | null {
  if (ctx.memberships[0]) return ctx.memberships[0].customer_id;
  return null;
}
