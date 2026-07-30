import "server-only";
import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import {
  type AppModuleKey,
  type AppProfileRole,
  type ResolvedAppProfile,
  DEFAULT_AGENT_TAGLINE,
  DEFAULT_AGENT_TITLE,
  fallbackTitles,
  roleLabelFor,
} from "@/lib/onboarding/appProfileTypes";

export type CustomerMembershipRole = "customer_admin" | "customer_user";

export type AccessContext = ResolvedAppProfile & {
  isPlatformAdmin: boolean;
  isGeneralAdmin: boolean;
  memberships: Array<{
    customer_id: string;
    role: CustomerMembershipRole;
    status: string;
    customer_name: string | null;
    customer_slug: string | null;
  }>;
};

async function loadModuleTitles(
  moduleKey: AppModuleKey,
): Promise<{ title: string; tagline: string }> {
  try {
    const supabase = await createClient();
    const { data } = await supabase
      .from("app_module_catalog")
      .select("agent_title, agent_tagline")
      .eq("module_key", moduleKey)
      .maybeSingle();
    if (data?.agent_title) {
      return { title: data.agent_title, tagline: data.agent_tagline };
    }
  } catch {
    /* ignore */
  }
  return fallbackTitles(moduleKey);
}

function mapRoleFromLegacy(opts: {
  isPlatformAdmin: boolean;
  membershipRole?: CustomerMembershipRole | null;
}): AppProfileRole {
  if (opts.isPlatformAdmin) return "general_admin";
  if (opts.membershipRole === "customer_admin") return "admin";
  return "user";
}

export async function getAccessContext(): Promise<AccessContext | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  let schemaReady = true;
  let isPlatformAdmin = false;

  const platformRes = await supabase
    .from("platform_admins")
    .select("user_id")
    .eq("user_id", user.id)
    .maybeSingle();

  if (platformRes.error) {
    schemaReady = false;
  } else {
    isPlatformAdmin = Boolean(platformRes.data);
  }

  const membershipsRes = await supabase
    .from("customer_memberships")
    .select("customer_id, role, status, customers(name, slug, logo_url)")
    .eq("user_id", user.id)
    .eq("status", "active");

  if (membershipsRes.error) {
    schemaReady = false;
  }

  const memberships = (membershipsRes.data ?? []).map((m) => {
    const c = m.customers as
      | { name: string; slug: string; logo_url?: string | null }
      | { name: string; slug: string; logo_url?: string | null }[]
      | null;
    const customer = Array.isArray(c) ? c[0] : c;
    return {
      customer_id: m.customer_id as string,
      role: m.role as CustomerMembershipRole,
      status: m.status as string,
      customer_name: customer?.name ?? null,
      customer_slug: customer?.slug ?? null,
      customer_logo_url: customer?.logo_url ?? null,
    };
  });

  const profileRes = await supabase
    .from("app_user_profiles")
    .select(
      "role, customer_id, display_name, module_sap, module_homepage, module_database, active_module, customers(name, slug, logo_url)",
    )
    .eq("user_id", user.id)
    .maybeSingle();

  if (profileRes.error && profileRes.error.code !== "PGRST116") {
    // table missing
    if (/relation|does not exist|schema cache/i.test(profileRes.error.message)) {
      schemaReady = false;
    }
  }

  let role: AppProfileRole;
  let customerId: string | null = null;
  let customerName: string | null = null;
  let customerSlug: string | null = null;
  let customerLogoUrl: string | null = null;
  let displayName: string | null = user.email ?? null;
  let moduleSap = false;
  let moduleHomepage = false;
  let moduleDatabase = false;
  let activeModule: AppModuleKey = "general";

  if (profileRes.data) {
    const p = profileRes.data;
    role = p.role as AppProfileRole;
    customerId = p.customer_id;
    displayName = p.display_name ?? displayName;
    moduleSap = Boolean(p.module_sap);
    moduleHomepage = Boolean(p.module_homepage);
    moduleDatabase = Boolean(p.module_database);
    activeModule = (p.active_module as AppModuleKey) ?? "general";
    const c = p.customers as
      | { name: string; slug: string; logo_url?: string | null }
      | { name: string; slug: string; logo_url?: string | null }[]
      | null;
    const customer = Array.isArray(c) ? c[0] : c;
    customerName = customer?.name ?? null;
    customerSlug = customer?.slug ?? null;
    customerLogoUrl = customer?.logo_url ?? null;
    if (role === "general_admin") isPlatformAdmin = true;
  } else {
    // Legacy fallback until profile row exists
    const primary = memberships[0];
    role = mapRoleFromLegacy({
      isPlatformAdmin,
      membershipRole: primary?.role,
    });
    customerId = primary?.customer_id ?? null;
    customerName = primary?.customer_name ?? null;
    customerSlug = primary?.customer_slug ?? null;
    customerLogoUrl = primary?.customer_logo_url ?? null;
    if (role === "general_admin") {
      moduleSap = true;
      moduleHomepage = true;
      moduleDatabase = true;
    }
  }

  const titles = await loadModuleTitles(activeModule);

  return {
    userId: user.id,
    email: user.email ?? null,
    role,
    displayName,
    customerId,
    customerName,
    customerSlug,
    customerLogoUrl,
    moduleSap,
    moduleHomepage,
    moduleDatabase,
    activeModule,
    agentTitle: titles.title || DEFAULT_AGENT_TITLE,
    agentTagline: titles.tagline || DEFAULT_AGENT_TAGLINE,
    roleLabel: roleLabelFor(role),
    schemaReady,
    isPlatformAdmin: isPlatformAdmin || role === "general_admin",
    isGeneralAdmin: role === "general_admin",
    memberships: memberships.map(({ customer_logo_url: _, ...rest }) => rest),
  };
}

export function canAccessAdmin(ctx: AccessContext, customerId?: string): boolean {
  if (!ctx.schemaReady && (ctx.isPlatformAdmin || ctx.role === "general_admin")) {
    return true;
  }
  if (!ctx.schemaReady) return true;
  if (ctx.role === "general_admin" || ctx.isPlatformAdmin) return true;
  if (ctx.role === "admin") {
    if (!customerId) return true;
    return ctx.customerId === customerId || ctx.memberships.some((m) => m.customer_id === customerId);
  }
  return false;
}

export function canAccessApp(ctx: AccessContext, customerId?: string): boolean {
  if (ctx.role === "general_admin" || ctx.isPlatformAdmin) return true;
  if (!customerId) return Boolean(ctx.customerId) || ctx.memberships.length > 0 || !ctx.schemaReady;
  return (
    ctx.customerId === customerId ||
    ctx.memberships.some((m) => m.customer_id === customerId)
  );
}

export async function requireUser(): Promise<AccessContext> {
  const ctx = await getAccessContext();
  if (!ctx) redirect("/login");
  return ctx;
}

export async function requireAdminAccess(customerId?: string): Promise<AccessContext> {
  const ctx = await requireUser();
  if (!canAccessAdmin(ctx, customerId)) {
    redirect("/admin/zugriff");
  }
  return ctx;
}

export async function requireAppAccess(customerId?: string): Promise<AccessContext> {
  const ctx = await requireUser();
  if (!canAccessApp(ctx, customerId)) {
    redirect("/");
  }
  return ctx;
}

export function primaryCustomerId(ctx: AccessContext): string | null {
  return ctx.customerId ?? ctx.memberships[0]?.customer_id ?? null;
}

/** Persist active module (product mode) for branding. */
export async function setActiveModuleForUser(
  userId: string,
  moduleKey: AppModuleKey,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const supabase = await createClient();
    const { data: profile, error } = await supabase
      .from("app_user_profiles")
      .select("user_id, module_sap, module_homepage, module_database")
      .eq("user_id", userId)
      .maybeSingle();
    if (error || !profile) {
      return { ok: false, error: error?.message ?? "Profil nicht gefunden" };
    }
    if (moduleKey === "sap" && !profile.module_sap) {
      return { ok: false, error: "Modul SAP ist nicht freigeschaltet" };
    }
    if (moduleKey === "homepage" && !profile.module_homepage) {
      return { ok: false, error: "Modul Homepage ist nicht freigeschaltet" };
    }
    if (moduleKey === "database" && !profile.module_database) {
      return { ok: false, error: "Modul Datenbank ist nicht freigeschaltet" };
    }
    const { error: upd } = await supabase
      .from("app_user_profiles")
      .update({ active_module: moduleKey })
      .eq("user_id", userId);
    if (upd) return { ok: false, error: upd.message };
    return { ok: true };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "Unbekannter Fehler",
    };
  }
}
