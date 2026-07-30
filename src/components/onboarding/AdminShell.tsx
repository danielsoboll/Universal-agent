import Link from "next/link";
import { signOut } from "@/actions/auth";

const ADMIN_LINKS = [
  { href: "/admin/dashboard", label: "Dashboard" },
  { href: "/admin/setup", label: "Setup" },
  { href: "/admin/checklist", label: "Fahrplan" },
  { href: "/admin/sources", label: "Quellen" },
  { href: "/admin/uploads", label: "Uploads" },
  { href: "/admin/pipeline", label: "Pipeline" },
  { href: "/admin/quality", label: "Qualität" },
  { href: "/admin/users", label: "Benutzer" },
];

export function AdminShell({
  email,
  roleLabel,
  children,
}: {
  email?: string | null;
  roleLabel?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen">
      <header className="border-b border-[var(--border)] bg-white/90 backdrop-blur">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-3 px-6 py-4">
          <div className="flex items-center gap-3">
            <Link href="/admin/dashboard" className="text-lg font-semibold">
              General Agent · Admin
            </Link>
            {roleLabel ? <span className="badge">{roleLabel}</span> : null}
          </div>
          <div className="flex items-center gap-3 text-sm">
            <span className="muted hidden sm:inline">{email}</span>
            <Link href="/app/search" className="btn btn-secondary">
              Zum Anwenderbereich
            </Link>
            <form action={signOut}>
              <button className="btn btn-secondary" type="submit">
                Abmelden
              </button>
            </form>
          </div>
        </div>
        <nav
          className="mx-auto flex w-full max-w-6xl gap-1 overflow-x-auto px-4 pb-3"
          aria-label="Admin-Navigation"
        >
          {ADMIN_LINKS.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className="whitespace-nowrap rounded-lg px-3 py-1.5 text-sm text-[var(--muted)] hover:bg-[#eef2f6] hover:text-[var(--foreground)]"
            >
              {l.label}
            </Link>
          ))}
        </nav>
      </header>
      <main className="mx-auto w-full max-w-6xl px-6 py-8">{children}</main>
    </div>
  );
}
