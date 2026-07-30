import Link from "next/link";
import { signOut } from "@/actions/auth";
import { ThemeToggle } from "@/components/ThemeToggle";
import { BrandMark } from "@/components/brand/BrandMark";

const APP_LINKS = [
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
        <div className="mx-auto flex w-full max-w-5xl items-center justify-between gap-2 px-4 py-3 sm:px-6 sm:py-4">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <BrandMark
              size={28}
              withName
              compactName
              href="/app/search"
              title={agentTitle}
              logoUrl={logoUrl}
            />
            <span className="badge shrink-0 text-[0.65rem]">Anwender</span>
          </div>
          <div className="flex shrink-0 items-center gap-1.5 sm:gap-2">
            <span className="muted hidden max-w-[10rem] truncate text-xs sm:inline">
              {email}
            </span>
            <ThemeToggle />
            <Link href="/" className="btn btn-secondary px-2.5 text-sm">
              Start
            </Link>
            <form action={signOut}>
              <button className="btn btn-secondary px-2.5 text-sm" type="submit">
                Abmelden
              </button>
            </form>
          </div>
        </div>
        <nav
          className="mx-auto flex w-full max-w-5xl gap-1 overflow-x-auto px-4 pb-3"
          aria-label="Anwender-Navigation"
        >
          {APP_LINKS.map((l) => (
            <Link key={l.href} href={l.href} className="nav-pill shrink-0">
              {l.label}
            </Link>
          ))}
        </nav>
      </header>
      <main className="page-shell mx-auto w-full max-w-5xl px-4 py-5 sm:px-6 sm:py-8">
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
