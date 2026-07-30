import { signOut } from "@/actions/auth";
import { createClient } from "@/lib/supabase/server";
import { ThemeToggle } from "@/components/ThemeToggle";
import { BrandMark } from "@/components/brand/BrandMark";

export async function AppHeader({
  roleLabel,
  agentTitle,
  logoUrl,
}: {
  roleLabel?: string;
  agentTitle?: string | null;
  logoUrl?: string | null;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  return (
    <header className="app-header">
      <div className="mx-auto flex w-full max-w-5xl items-center justify-between gap-4 px-6 py-4">
        <div className="flex min-w-0 items-center gap-3">
          <BrandMark
            size={32}
            withName
            title={agentTitle}
            logoUrl={logoUrl}
          />
          {roleLabel ? <span className="badge shrink-0">{roleLabel}</span> : null}
        </div>
        <div className="flex items-center gap-2 text-sm sm:gap-3">
          <span className="muted hidden sm:inline">{user?.email}</span>
          <ThemeToggle />
          <form action={signOut}>
            <button className="btn btn-secondary" type="submit">
              Abmelden
            </button>
          </form>
        </div>
      </div>
    </header>
  );
}
