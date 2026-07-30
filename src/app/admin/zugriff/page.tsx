import Link from "next/link";
import { AppHeader } from "@/components/AppHeader";
import { requireUser, canAccessAdmin } from "@/lib/onboarding/access";
import { redirect } from "next/navigation";

export default async function AdminZugriffPage() {
  const ctx = await requireUser();
  if (canAccessAdmin(ctx)) {
    redirect("/admin/dashboard");
  }

  return (
    <>
      <AppHeader />
      <main className="mx-auto w-full max-w-xl px-6 py-12">
        <div className="panel p-8">
          <p className="hero-kicker">Admin</p>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight">
            Kein Admin-Zugriff
          </h1>
          <p className="muted mt-3 text-sm leading-relaxed">
            {!ctx.schemaReady
              ? "Die Onboarding-Tabellen sind in Supabase noch nicht vorhanden. Bitte zuerst die Migrationen 20260731000100–003 anwenden."
              : "Dein Konto ist weder Platform Admin noch Customer Admin. Ein Platform Admin muss dich freischalten oder in platform_admins eintragen."}
          </p>
          <div className="mt-6 flex flex-wrap gap-3">
            <Link href="/" className="btn btn-primary">
              Zur Startseite
            </Link>
            <Link href="/app/search" className="btn btn-secondary">
              Zum Anwenderbereich
            </Link>
          </div>
        </div>
      </main>
    </>
  );
}
