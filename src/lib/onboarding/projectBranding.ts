import { APP_NAME } from "@/lib/branding";

/** Sticky-header title for project-scoped users: „{Projektname} Agent“. */
export function projectAgentTitle(customerName: string | null | undefined): string {
  const name = customerName?.trim();
  if (!name) return APP_NAME;
  if (/ agent$/i.test(name)) return name;
  return `${name} Agent`;
}

/**
 * Chrome branding for admin/app shells.
 * General Admin keeps „General Agent“; Projekt-Admin / Benutzer get project brand.
 */
export function resolveShellBranding(opts: {
  isGeneralAdmin: boolean;
  customerName: string | null | undefined;
  customerLogoUrl: string | null | undefined;
  /** Unused for general admin — always „General Agent“. */
  fallbackTitle?: string | null;
}): { title: string; logoUrl: string | null } {
  if (opts.isGeneralAdmin) {
    return {
      title: APP_NAME,
      logoUrl: null,
    };
  }
  return {
    title: projectAgentTitle(opts.customerName),
    logoUrl: opts.customerLogoUrl?.trim() || null,
  };
}
