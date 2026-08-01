import Link from "next/link";
import { AppHeader } from "@/components/AppHeader";
import {
  canAccessAdmin,
  canAccessProjectConsole,
  requireUser,
} from "@/lib/onboarding/access";
import { PROJECT_ADMIN_REQUIRED_HINT } from "@/lib/onboarding/permissions";
import { redirect } from "next/navigation";

export default async function AdminZugriffPage() {
  const ctx = await requireUser();
  if (canAccessAdmin(ctx)) {
    redirect("/admin/dashboard");
  }
  // Projekt-Benutzer: Console ja, Mutationen nein — zurück zum Dashboard.
  if (canAccessProjectConsole(ctx)) {
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
              ? "Die Onboarding-Tabellen sind in Supabase noch nicht vorhanden. Bitte zuerst die Migrationen anwenden."
              : `${PROJECT_ADMIN_REQUIRED_HINT}. Dein Konto hat weder General-Admin- noch Projekt-Admin-Rechte.`}
          </p>
          <div className="mt-6 flex flex-wrap gap-3">
            <Link href="/" className="btn btn-primary">
              Zur Startseite
            </Link>
            <Link href="/app/ask" className="btn btn-secondary">
              Zum Anwenderbereich
            </Link>
          </div>
        </div>
      </main>
    </>
  );
}
