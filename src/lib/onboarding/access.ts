import "server-only";
import { cache } from "react";
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
import {
  PROJECT_ADMIN_REQUIRED_HINT,
  roleCanMutateProjectSetup,
  roleCanViewProjectConsole,
} from "@/lib/onboarding/permissions";

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

export { PROJECT_ADMIN_REQUIRED_HINT };

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

export const getAccessContext = cache(async (): Promise<AccessContext | null> => {
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
    console.error("[access] platform_admins", platformRes.error.message);
    schemaReady = false;
  } else {
    isPlatformAdmin = Boolean(platformRes.data);
  }

  type MembershipRow = {
    customer_id: string;
    role: string;
    status: string;
    customers:
      | {
          name: string;
          slug: string;
          logo_url?: string | null;
          product_module?: string | null;
        }
      | {
          name: string;
          slug: string;
          logo_url?: string | null;
          product_module?: string | null;
        }[]
      | null;
  };

  let membershipRows: MembershipRow[] = [];

  {
    const withModule = await supabase
      .from("customer_memberships")
      .select(
        "customer_id, role, status, customers(name, slug, logo_url, product_module)",
      )
      .eq("user_id", user.id)
      .eq("status", "active");

    if (withModule.error) {
      console.error("[access] memberships+module", withModule.error.message);
      if (/column|schema cache|product_module/i.test(withModule.error.message)) {
        schemaReady = false;
      }
      const withoutModule = await supabase
        .from("customer_memberships")
        .select("customer_id, role, status, customers(name, slug, logo_url)")
        .eq("user_id", user.id)
        .eq("status", "active");
      if (withoutModule.error) {
        console.error("[access] memberships", withoutModule.error.message);
        schemaReady = false;
        const bare = await supabase
          .from("customer_memberships")
          .select("customer_id, role, status, customers(name, slug)")
          .eq("user_id", user.id)
          .eq("status", "active");
        if (!bare.error) {
          membershipRows = (bare.data ?? []) as unknown as MembershipRow[];
        }
      } else {
        membershipRows = (withoutModule.data ?? []) as unknown as MembershipRow[];
      }
    } else {
      membershipRows = (withModule.data ?? []) as unknown as MembershipRow[];
    }
  }

  const memberships = membershipRows.map((m) => {
    const c = m.customers;
    const customer = Array.isArray(c) ? c[0] : c;
    return {
      customer_id: m.customer_id as string,
      role: m.role as CustomerMembershipRole,
      status: m.status as string,
      customer_name: customer?.name ?? null,
      customer_slug: customer?.slug ?? null,
      customer_logo_url: customer?.logo_url ?? null,
      product_module: (customer?.product_module as AppModuleKey | undefined) ?? "general",
    };
  });

  type ProfileRow = {
    role: string;
    customer_id: string | null;
    display_name: string | null;
    module_sap: boolean | null;
    module_homepage: boolean | null;
    module_database: boolean | null;
    active_module: string | null;
    customers:
      | {
          name: string;
          slug: string;
          logo_url?: string | null;
          product_module?: string | null;
        }
      | {
          name: string;
          slug: string;
          logo_url?: string | null;
          product_module?: string | null;
        }[]
      | null;
  };

  let profileData: ProfileRow | null = null;

  {
    const profileRes = await supabase
      .from("app_user_profiles")
      .select(
        "role, customer_id, display_name, module_sap, module_homepage, module_database, active_module, customers(name, slug, logo_url, product_module)",
      )
      .eq("user_id", user.id)
      .maybeSingle();

    if (profileRes.error && profileRes.error.code !== "PGRST116") {
      console.error("[access] profile+logo", profileRes.error.message);
      if (/relation|does not exist|schema cache|column/i.test(profileRes.error.message)) {
        schemaReady = false;
        const fallback = await supabase
          .from("app_user_profiles")
          .select(
            "role, customer_id, display_name, module_sap, module_homepage, module_database, active_module, customers(name, slug)",
          )
          .eq("user_id", user.id)
          .maybeSingle();
        if (!fallback.error && fallback.data) {
          profileData = fallback.data as unknown as ProfileRow;
        }
      }
    } else if (profileRes.data) {
      profileData = profileRes.data as unknown as ProfileRow;
    }
  }

  let role: AppProfileRole;
  let customerId: string | null = null;
  let customerName: string | null = null;
  let customerSlug: string | null = null;
  let customerLogoUrl: string | null = null;
  let productModule: AppModuleKey = "general";
  let displayName: string | null = user.email ?? null;
  let moduleSap = false;
  let moduleHomepage = false;
  let moduleDatabase = false;
  let activeModule: AppModuleKey = "general";

  if (profileData) {
    const p = profileData;
    role = p.role as AppProfileRole;
    customerId = p.customer_id;
    displayName = p.display_name ?? displayName;
    moduleSap = Boolean(p.module_sap);
    moduleHomepage = Boolean(p.module_homepage);
    moduleDatabase = Boolean(p.module_database);
    activeModule = (p.active_module as AppModuleKey) ?? "general";
    const c = p.customers;
    const customer = Array.isArray(c) ? c[0] : c;
    customerName = customer?.name ?? null;
    customerSlug = customer?.slug ?? null;
    customerLogoUrl = customer?.logo_url ?? null;
    if (customer?.product_module) {
      productModule = customer.product_module as AppModuleKey;
    }
    if (role === "general_admin") isPlatformAdmin = true;
  } else {
    const primary = memberships[0];
    role = mapRoleFromLegacy({
      isPlatformAdmin,
      membershipRole: primary?.role,
    });
    customerId = primary?.customer_id ?? null;
    customerName = primary?.customer_name ?? null;
    customerSlug = primary?.customer_slug ?? null;
    customerLogoUrl = primary?.customer_logo_url ?? null;
    productModule = primary?.product_module ?? "general";
    if (role === "general_admin") {
      moduleSap = true;
      moduleHomepage = true;
      moduleDatabase = true;
    }
  }

  // Projekt-Klassifizierung steuert Branding für Anwender (nicht freier Modul-Switcher).
  if (productModule === "sap") {
    moduleSap = true;
    activeModule = "sap";
  } else if (productModule === "homepage") {
    moduleHomepage = true;
    activeModule = "homepage";
  } else if (productModule === "database") {
    moduleDatabase = true;
    activeModule = "database";
  }

  // Guard invalid active_module vs checkboxes
  if (
    (activeModule === "sap" && !moduleSap) ||
    (activeModule === "homepage" && !moduleHomepage) ||
    (activeModule === "database" && !moduleDatabase)
  ) {
    activeModule = productModule !== "general" ? productModule : "general";
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
    productModule,
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
    memberships: memberships.map(
      ({ customer_logo_url: _logo, product_module: _pm, ...rest }) => rest,
    ),
  };
});

function belongsToCustomer(ctx: AccessContext, customerId: string): boolean {
  return (
    ctx.customerId === customerId ||
    ctx.memberships.some((m) => m.customer_id === customerId)
  );
}

/** Mutating admin access: General Admin + Projekt-Admin only. */
export function canAccessAdmin(ctx: AccessContext, customerId?: string): boolean {
  // Bei fehlendem Schema nur bekannte Platform-Admins durchlassen — nie alle Nutzer.
  if (!ctx.schemaReady) {
    return ctx.isPlatformAdmin || ctx.role === "general_admin";
  }
  if (ctx.role === "general_admin" || ctx.isPlatformAdmin) return true;
  if (ctx.role === "admin" && roleCanMutateProjectSetup(ctx.role)) {
    if (!customerId) return true;
    return belongsToCustomer(ctx, customerId);
  }
  return false;
}

/**
 * Read access to project console (Dashboard + 6 Hauptschritte details).
 * Includes Projekt-Benutzer (view-only).
 */
export function canAccessProjectConsole(
  ctx: AccessContext,
  customerId?: string,
): boolean {
  if (!ctx.schemaReady) {
    return ctx.isPlatformAdmin || ctx.role === "general_admin";
  }
  if (ctx.role === "general_admin" || ctx.isPlatformAdmin) return true;
  if (!roleCanViewProjectConsole(ctx.role)) return false;
  if (!customerId) {
    return Boolean(ctx.customerId) || ctx.memberships.length > 0;
  }
  return belongsToCustomer(ctx, customerId);
}

/** Alias: run setup / import / fahrplan actions. */
export function canMutateProjectSetup(
  ctx: AccessContext,
  customerId?: string,
): boolean {
  return canAccessAdmin(ctx, customerId);
}

export function isProjectUser(ctx: AccessContext): boolean {
  return (
    ctx.role === "user" &&
    !ctx.isGeneralAdmin &&
    !ctx.isPlatformAdmin
  );
}

export function canAccessApp(ctx: AccessContext, customerId?: string): boolean {
  if (ctx.role === "general_admin" || ctx.isPlatformAdmin) return true;
  // Strikte Projekt-Isolation: ohne Mitgliedschaft kein Anwenderzugang.
  if (!customerId) {
    return Boolean(ctx.customerId) || ctx.memberships.length > 0;
  }
  return belongsToCustomer(ctx, customerId);
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

/** Dashboard / step detail views — Projekt-Admin und Projekt-Benutzer. */
export async function requireProjectConsoleAccess(
  customerId?: string,
): Promise<AccessContext> {
  const ctx = await requireUser();
  if (!canAccessProjectConsole(ctx, customerId)) {
    redirect("/admin/zugriff");
  }
  return ctx;
}

/**
 * Server-action guard for mutations. Throws with the UX hint string
 * so clients can surface „Projekt-Admin muss diesen Schritt erledigen“.
 */
export async function requireProjectMutationAccess(
  customerId?: string,
): Promise<AccessContext> {
  const ctx = await requireUser();
  if (!canMutateProjectSetup(ctx, customerId)) {
    throw new Error(PROJECT_ADMIN_REQUIRED_HINT);
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

/** Customer IDs the current user may see in the project console. */
export function accessibleCustomerIds(ctx: AccessContext): string[] {
  if (ctx.isPlatformAdmin || ctx.isGeneralAdmin) return [];
  const ids = new Set<string>();
  if (ctx.customerId) ids.add(ctx.customerId);
  for (const m of ctx.memberships) ids.add(m.customer_id);
  return [...ids];
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
