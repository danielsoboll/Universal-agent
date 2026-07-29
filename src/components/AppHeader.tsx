import Link from "next/link";
import { signOut } from "@/actions/auth";
import { createClient } from "@/lib/supabase/server";

export async function AppHeader({ roleLabel }: { roleLabel?: string }) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  return (
    <header className="border-b border-[var(--border)] bg-white/80 backdrop-blur">
      <div className="mx-auto flex w-full max-w-5xl items-center justify-between gap-4 px-6 py-4">
        <div className="flex items-center gap-4">
          <Link href="/" className="text-lg font-semibold tracking-tight">
            General Agent
          </Link>
          {roleLabel ? <span className="badge">{roleLabel}</span> : null}
        </div>
        <div className="flex items-center gap-3 text-sm">
          <span className="muted hidden sm:inline">{user?.email}</span>
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
