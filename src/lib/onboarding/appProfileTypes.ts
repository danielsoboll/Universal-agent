import "server-only";

export type AppProfileRole = "general_admin" | "admin" | "user";
export type AppModuleKey = "general" | "sap" | "homepage" | "database";

export type ResolvedAppProfile = {
  userId: string;
  email: string | null;
  role: AppProfileRole;
  displayName: string | null;
  customerId: string | null;
  customerName: string | null;
  customerSlug: string | null;
  customerLogoUrl: string | null;
  /** Klassifizierung des zugeordneten Projekts (DB: customers.product_module). */
  productModule: AppModuleKey;
  moduleSap: boolean;
  moduleHomepage: boolean;
  moduleDatabase: boolean;
  activeModule: AppModuleKey;
  agentTitle: string;
  agentTagline: string;
  roleLabel: string;
  schemaReady: boolean;
};

export const DEFAULT_AGENT_TITLE = "General Agent";
export const DEFAULT_AGENT_TAGLINE = "Universal Knowledge Analyzer";

export const MODULE_LABELS: Record<AppModuleKey, string> = {
  general: "General",
  sap: "SAP",
  homepage: "Homepage",
  database: "Datenbank",
};

export function roleLabelFor(role: AppProfileRole): string {
  switch (role) {
    case "general_admin":
      return "General Admin";
    case "admin":
      return "Projekt-Admin";
    case "user":
      return "Projekt-Benutzer";
  }
}

export function fallbackTitles(module: AppModuleKey): {
  title: string;
  tagline: string;
} {
  switch (module) {
    case "sap":
      return {
        title: "SAP Analyse Agent",
        tagline: "Code, Steuertabellen und Relationen verstehen",
      };
    case "homepage":
      return {
        title: "Homepage Analyse Agent",
        tagline: "Webseiten und Inhalte analysieren",
      };
    case "database":
      return {
        title: "Datenbank Analyse Agent",
        tagline: "Datenmodelle und Bestände erschließen",
      };
    default:
      return {
        title: DEFAULT_AGENT_TITLE,
        tagline: DEFAULT_AGENT_TAGLINE,
      };
  }
}

export function enabledModules(profile: {
  moduleSap: boolean;
  moduleHomepage: boolean;
  moduleDatabase: boolean;
}): AppModuleKey[] {
  const list: AppModuleKey[] = ["general"];
  if (profile.moduleSap) list.push("sap");
  if (profile.moduleHomepage) list.push("homepage");
  if (profile.moduleDatabase) list.push("database");
  return list;
}

/** Modul-Flags aus der Projekt-Klassifizierung (customers.product_module). */
export function moduleFlagsFromProduct(module: AppModuleKey): {
  module_sap: boolean;
  module_homepage: boolean;
  module_database: boolean;
  active_module: AppModuleKey;
} {
  return {
    module_sap: module === "sap",
    module_homepage: module === "homepage",
    module_database: module === "database",
    active_module: module,
  };
}

export function isAppModuleKey(value: string): value is AppModuleKey {
  return (
    value === "general" ||
    value === "sap" ||
    value === "homepage" ||
    value === "database"
  );
}
