import Link from "next/link";
import { signOut } from "@/actions/auth";
import { ThemeToggle } from "@/components/ThemeToggle";
import { BrandMark } from "@/components/brand/BrandMark";
import { getAccessContext } from "@/lib/onboarding/access";

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

export async function AdminShell({
  email,
  roleLabel,
  children,
}: {
  email?: string | null;
  roleLabel?: string;
  children: React.ReactNode;
}) {
  const profile = await getAccessContext();

  return (
    <div className="min-h-screen">
      <header className="app-header">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-3 px-6 py-4">
          <div className="flex min-w-0 items-center gap-3">
            <BrandMark
              size={32}
              withName
              href="/admin/dashboard"
              title={profile?.agentTitle}
              logoUrl={profile?.customerLogoUrl}
            />
            {roleLabel ? <span className="badge shrink-0">{roleLabel}</span> : null}
            {profile?.customerName ? (
              <span className="muted hidden text-sm lg:inline">
                {profile.customerName}
              </span>
            ) : null}
          </div>
          <div className="flex items-center gap-2 text-sm sm:gap-3">
            <span className="muted hidden md:inline">{email}</span>
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
          className="mx-auto flex w-full max-w-6xl gap-1 overflow-x-auto px-4 pb-3"
          aria-label="Admin-Navigation"
        >
          {ADMIN_LINKS.map((l) => (
            <Link key={l.href} href={l.href} className="nav-pill">
              {l.label}
            </Link>
          ))}
        </nav>
      </header>
      <main className="mx-auto w-full max-w-6xl px-6 py-8">{children}</main>
    </div>
  );
}
