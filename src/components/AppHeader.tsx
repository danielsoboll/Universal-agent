import { ThemeToggle } from "@/components/ThemeToggle";
import { BrandMark } from "@/components/brand/BrandMark";
import { createClient } from "@/lib/supabase/server";

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
    <header className="app-header pt-safe">
      <div className="mx-auto flex w-full max-w-5xl items-center justify-between gap-2 px-4 py-3 sm:gap-3 sm:px-6 sm:py-4">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <BrandMark
            size={28}
            withName
            compactName
            title={agentTitle}
            logoUrl={logoUrl}
          />
          {roleLabel ? (
            <span className="badge shrink-0 text-[0.65rem]">{roleLabel}</span>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1.5 sm:gap-2">
          <span className="muted hidden max-w-[10rem] truncate text-xs lg:inline">
            {user?.email}
          </span>
          <ThemeToggle />
          <form action="/auth/signout" method="post">
            <button className="btn btn-secondary px-2.5 text-sm" type="submit">
              Abmelden
            </button>
          </form>
        </div>
      </div>
    </header>
  );
}
