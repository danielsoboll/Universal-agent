import Link from "next/link";
import { ThemeToggle } from "@/components/ThemeToggle";
import { BrandMark } from "@/components/brand/BrandMark";
import { SapProjectBrand } from "@/components/brand/SapProjectBrand";
import { InternalStickyChrome } from "@/components/layout/InternalStickyChrome";
import { AppBackNav } from "@/components/onboarding/AppBackNav";
import type { AppModuleKey } from "@/lib/onboarding/appProfileTypes";

const APP_LINKS = [
  { href: "/app", label: "Übersicht" },
  { href: "/app/ask", label: "Fragen" },
  { href: "/app/search", label: "Suche" },
  { href: "/app/sources", label: "Quellen" },
  { href: "/app/history", label: "Verlauf" },
];

export function AppShell({
  email,
  released,
  agentTitle,
  logoUrl,
  productModule = "general",
  children,
}: {
  email?: string | null;
  released: boolean;
  agentTitle?: string | null;
  logoUrl?: string | null;
  productModule?: AppModuleKey;
  children: React.ReactNode;
}) {
  const isSap = productModule === "sap";

  return (
    <InternalStickyChrome
      beforeChrome={isSap ? <SapProjectBrand /> : null}
      header={
        <div className="mx-auto flex w-full max-w-5xl items-center justify-between gap-2 px-3 py-1.5 sm:gap-3 sm:px-6 sm:py-2">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            {isSap ? <SapProjectBrand compactSlot /> : null}
            <BrandMark
              size={22}
              withName
              href="/app"
              title={agentTitle}
              logoUrl={logoUrl}
            />
          </div>
          <div className="flex shrink-0 items-center gap-1 sm:gap-1.5">
            <ThemeToggle />
          </div>
        </div>
      }
      backNav={
        <div className="mx-auto w-full max-w-5xl px-3 sm:px-6">
          <AppBackNav />
        </div>
      }
      mainClassName="page-shell mx-auto flex w-full max-w-5xl flex-col px-3 py-4 sm:px-6 sm:py-8"
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <nav
          className="flex min-w-0 flex-1 gap-1 overflow-x-auto"
          aria-label="Anwender-Navigation"
        >
          {APP_LINKS.map((l) => (
            <Link key={l.href} href={l.href} className="nav-pill shrink-0">
              {l.label}
            </Link>
          ))}
        </nav>
        <div className="flex shrink-0 items-center gap-1 sm:gap-1.5">
          <span className="badge hidden text-[0.6rem] sm:inline">Anwender</span>
          <span className="muted hidden max-w-[9rem] truncate text-xs lg:inline">
            {email}
          </span>
        </div>
      </div>
      {!released ? (
        <div
          className="panel compact mb-4 p-3 text-sm"
          style={{ background: "var(--accent-soft)" }}
        >
          <p className="font-semibold">Noch nicht freigegeben</p>
          <p className="muted mt-1">
            Die Anwenderfreigabe steht noch aus (Projektstatus). Status und
            Fragen bleiben einsehbar.
          </p>
        </div>
      ) : null}
      <div className="min-w-0 flex-1">{children}</div>
      <div className="mt-8 border-t border-[var(--border)] pt-4 pb-2">
        <form action="/auth/signout" method="post">
          <button
            type="submit"
            className="btn btn-secondary btn-quiet flex min-h-12 w-full items-center justify-center text-[1.0625rem]"
          >
            Abmelden
          </button>
        </form>
      </div>
    </InternalStickyChrome>
  );
}
