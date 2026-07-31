import Link from "next/link";
import { ThemeToggle } from "@/components/ThemeToggle";
import { BrandMark } from "@/components/brand/BrandMark";

const APP_LINKS = [
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
  children,
}: {
  email?: string | null;
  released: boolean;
  agentTitle?: string | null;
  logoUrl?: string | null;
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen pb-safe">
      <header className="app-header pt-safe">
        <div className="mx-auto flex w-full max-w-5xl items-center justify-between gap-2 px-3 py-2.5 sm:gap-3 sm:px-6 sm:py-4">
          <div className="min-w-0 flex-1">
            <BrandMark
              size={28}
              withName
              compactName={false}
              href="/app/ask"
              title={agentTitle}
              logoUrl={logoUrl}
            />
          </div>
          <div className="flex shrink-0 items-center gap-1 sm:gap-1.5">
            <span className="badge hidden text-[0.6rem] sm:inline">Anwender</span>
            <span className="muted hidden max-w-[9rem] truncate text-xs lg:inline">
              {email}
            </span>
            <ThemeToggle />
            <form action="/auth/signout" method="post">
              <button
                className="btn btn-secondary px-2 text-xs sm:px-2.5 sm:text-sm"
                type="submit"
              >
                Abmelden
              </button>
            </form>
          </div>
        </div>
        <nav
          className="mx-auto flex w-full max-w-5xl gap-1 overflow-x-auto px-3 pb-2.5 sm:px-6"
          aria-label="Anwender-Navigation"
        >
          {APP_LINKS.map((l) => (
            <Link key={l.href} href={l.href} className="nav-pill shrink-0">
              {l.label}
            </Link>
          ))}
        </nav>
      </header>
      <main className="page-shell mx-auto w-full max-w-5xl px-3 py-4 sm:px-6 sm:py-8">
        {!released ? (
          <div
            className="panel compact mb-4 p-3 text-sm"
            style={{ background: "var(--accent-soft)" }}
          >
            <p className="font-semibold">Noch nicht freigegeben</p>
            <p className="muted mt-1">
              Die Anwenderfreigabe im Admin-Fahrplan steht noch aus.
            </p>
          </div>
        ) : null}
        {children}
      </main>
    </div>
  );
}
