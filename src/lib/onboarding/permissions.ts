/**
 * Project-scoped permission helpers (client-safe).
 * Roles map to existing DB enums:
 * - general_admin → General Admin (platform)
 * - admin / customer_admin → Projekt-Admin
 * - user / customer_user → Projekt-Benutzer
 */

export const PROJECT_ADMIN_REQUIRED_HINT =
  "Projekt-Admin muss diesen Schritt erledigen";

export type ProjectCapabilityRole =
  | "general_admin"
  | "admin"
  | "user";

export function isGeneralAdminRole(role: ProjectCapabilityRole): boolean {
  return role === "general_admin";
}

export function isProjectAdminRole(role: ProjectCapabilityRole): boolean {
  return role === "admin" || role === "general_admin";
}

/** Can view project console (dashboard + 6 Hauptschritte details). */
export function roleCanViewProjectConsole(
  role: ProjectCapabilityRole,
): boolean {
  return role === "general_admin" || role === "admin" || role === "user";
}

/** Can run setup / fahrplan / import mutations inside the 6 Hauptschritte. */
export function roleCanMutateProjectSetup(
  role: ProjectCapabilityRole,
): boolean {
  return role === "general_admin" || role === "admin";
}
