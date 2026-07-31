import Link from "next/link";
import { ThemeToggle } from "@/components/ThemeToggle";
import { BrandMark } from "@/components/brand/BrandMark";
import { AdminNav } from "@/components/onboarding/AdminNav";

export function AdminShell({
  email,
  roleLabel,
  agentTitle,
  logoUrl,
  customerName,
  children,
}: {
  email?: string | null;
  roleLabel?: string;
  agentTitle?: string | null;
  logoUrl?: string | null;
  customerName?: string | null;
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen pb-safe">
      <header className="app-header pt-safe">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-2 px-4 py-3 sm:gap-3 sm:px-6 sm:py-4">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <BrandMark
              size={28}
              withName
              compactName
              href="/admin/dashboard"
              title={agentTitle}
              logoUrl={logoUrl}
            />
            {roleLabel ? (
              <span className="badge shrink-0 text-[0.65rem]">{roleLabel}</span>
            ) : null}
            {customerName ? (
              <span className="muted hidden truncate text-sm xl:inline">
                {customerName}
              </span>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-1.5 sm:gap-2">
            <span className="muted hidden max-w-[10rem] truncate text-xs lg:inline">
              {email}
            </span>
            <ThemeToggle />
            <Link href="/" className="btn btn-secondary hidden sm:inline-flex">
              Start
            </Link>
            <form action="/auth/signout" method="post">
              <button className="btn btn-secondary px-2.5 text-sm" type="submit">
                Abmelden
              </button>
            </form>
          </div>
        </div>
        <AdminNav />
      </header>
      <main className="page-shell mx-auto w-full max-w-6xl px-4 py-5 sm:px-6 sm:py-8">
        {children}
      </main>
    </div>
  );
}
