import Link from "next/link";
import { localSignOut } from "@/actions/localAuth";
import { ThemeToggle } from "@/components/ThemeToggle";
import { BrandMark } from "@/components/brand/BrandMark";

const APP_LINKS = [
  { href: "/app/ask", label: "Fragen" },
  { href: "/app/history", label: "Verlauf" },
  { href: "/app/sources", label: "Quellen" },
];

export function LocalAppShell({
  email,
  agentTitle,
  children,
}: {
  email?: string | null;
  agentTitle?: string | null;
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen pb-safe">
      <header className="app-header pt-safe">
        <div className="mx-auto flex w-full max-w-5xl items-center justify-between gap-2 px-3 py-2.5 sm:px-6 sm:py-4">
          <div className="min-w-0 flex-1">
            <BrandMark
              size={28}
              withName
              compactName={false}
              href="/app"
              title={agentTitle}
            />
          </div>
          <div className="flex shrink-0 items-center gap-1 sm:gap-1.5">
            <span className="badge text-[0.6rem]">User</span>
            <span className="muted hidden max-w-[9rem] truncate text-xs lg:inline">
              {email}
            </span>
            <ThemeToggle />
            <form action={localSignOut}>
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
        {children}
      </main>
    </div>
  );
}
