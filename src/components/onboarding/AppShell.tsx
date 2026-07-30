import Link from "next/link";
import { signOut } from "@/actions/auth";

const APP_LINKS = [
  { href: "/app/search", label: "Suche" },
  { href: "/app/sources", label: "Quellen" },
  { href: "/app/history", label: "Verlauf" },
];

export function AppShell({
  email,
  released,
  children,
}: {
  email?: string | null;
  released: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen">
      <header className="border-b border-[var(--border)] bg-white/90 backdrop-blur">
        <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center justify-between gap-3 px-6 py-4">
          <div className="flex items-center gap-3">
            <Link href="/app/search" className="text-lg font-semibold">
              General Agent
            </Link>
            <span className="badge">Anwender</span>
          </div>
          <div className="flex items-center gap-3 text-sm">
            <span className="muted hidden sm:inline">{email}</span>
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
            <Link
              key={l.href}
              href={l.href}
              className="rounded-lg px-3 py-1.5 text-sm text-[var(--muted)] hover:bg-[#eef2f6] hover:text-[var(--foreground)]"
            >
              {l.label}
            </Link>
          ))}
        </nav>
      </header>
      <main className="mx-auto w-full max-w-5xl px-6 py-8">
        {!released ? (
          <div className="panel mb-6 border-amber-300 bg-amber-50 p-4 text-sm">
            <p className="font-semibold">Noch nicht freigegeben</p>
            <p className="muted mt-1">
              Der Admin-Fahrplan hat die Anwenderfreigabe noch nicht abgeschlossen.
              Suche und Analyse sind vorbereitet, aber noch nicht nutzbar.
            </p>
          </div>
        ) : null}
        {children}
      </main>
    </div>
  );
}
