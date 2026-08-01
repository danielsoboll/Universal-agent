import { ThemeToggle } from "@/components/ThemeToggle";
import { BrandMark } from "@/components/brand/BrandMark";
import { SapProjectBrand } from "@/components/brand/SapProjectBrand";
import { InternalStickyChrome } from "@/components/layout/InternalStickyChrome";
import { AdminBackNav } from "@/components/onboarding/AdminBackNav";
import type { AppModuleKey } from "@/lib/onboarding/appProfileTypes";

/**
 * Compact admin chrome for the SAP data-import setup app.
 * Sticky: global header (logo + name + theme) + back link only.
 * Logout lives only on the start page (/).
 */
export function AdminShell({
  agentTitle,
  logoUrl,
  productModule = "general",
  children,
}: {
  email?: string | null;
  agentTitle?: string | null;
  logoUrl?: string | null;
  customerName?: string | null;
  productModule?: AppModuleKey;
  children: React.ReactNode;
}) {
  const isSap = productModule === "sap";

  return (
    <InternalStickyChrome
      beforeChrome={isSap ? <SapProjectBrand /> : null}
      header={
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-1 px-3 py-1.5 sm:gap-3 sm:px-6 sm:py-2">
          <div className="flex min-w-0 flex-1 items-center gap-1.5 sm:gap-2">
            {isSap ? <SapProjectBrand compactSlot /> : null}
            <BrandMark
              size={22}
              withName
              href="/admin/dashboard"
              title={agentTitle}
              logoUrl={logoUrl}
            />
          </div>
          <div className="flex shrink-0 items-center gap-0.5 sm:gap-1.5">
            <ThemeToggle />
          </div>
        </div>
      }
      backNav={
        <div className="mx-auto w-full max-w-6xl px-3 sm:px-6">
          <AdminBackNav />
        </div>
      }
      mainClassName="admin-main page-shell mx-auto w-full max-w-6xl px-3 pt-2 sm:px-6 sm:pt-4"
    >
      {children}
    </InternalStickyChrome>
  );
}
