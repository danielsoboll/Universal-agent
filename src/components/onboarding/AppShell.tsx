import Link from "next/link";
import { signOut } from "@/actions/auth";
import { ThemeToggle } from "@/components/ThemeToggle";
import { BrandMark } from "@/components/brand/BrandMark";
import { getAccessContext } from "@/lib/onboarding/access";

const APP_LINKS = [
  { href: "/app/search", label: "Suche" },
  { href: "/app/sources", label: "Quellen" },
  { href: "/app/history", label: "Verlauf" },
];

export async function AppShell({
  email,
  released,
  children,
}: {
  email?: string | null;
  released: boolean;
  children: React.ReactNode;
}) {
  const profile = await getAccessContext();

  return (
    <div className="min-h-screen">
      <header className="app-header">
        <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center justify-between gap-3 px-6 py-4">
          <div className="flex min-w-0 items-center gap-3">
            <BrandMark
              size={32}
              withName
              href="/app/search"
              title={profile?.agentTitle}
              logoUrl={profile?.customerLogoUrl}
            />
            <span className="badge shrink-0">Anwender</span>
          </div>
          <div className="flex items-center gap-2 text-sm sm:gap-3">
            <span className="muted hidden sm:inline">{email}</span>
            <ThemeToggle />
            <Link href="/" className="btn btn-secondary">
              Start
            </Link>
            <form action={signOut}>
              <button className="btn btn-secondary" type="submit">
                Abmelden
              </button>
            </form>
          </div>
        </div>
        <nav
          className="mx-auto flex w-full max-w-5xl gap-1 px-4 pb-3"
          aria-label="Anwender-Navigation"
        >
          {APP_LINKS.map((l) => (
            <Link key={l.href} href={l.href} className="nav-pill">
              {l.label}
            </Link>
          ))}
        </nav>
      </header>
      <main className="mx-auto w-full max-w-5xl px-6 py-8">
        {!released ? (
          <div
            className="panel mb-6 p-4 text-sm"
            style={{ background: "var(--accent-soft)" }}
          >
            <p className="font-semibold">Noch nicht freigegeben</p>
            <p className="muted mt-1">
              Der Admin-Fahrplan hat die Anwenderfreigabe noch nicht abgeschlossen.
            </p>
          </div>
        ) : null}
        {children}
      </main>
    </div>
  );
}
