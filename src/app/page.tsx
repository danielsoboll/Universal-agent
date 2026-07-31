import Link from "next/link";
import { AppHeader } from "@/components/AppHeader";
import { HomePwaHelp } from "@/components/home/HomePwaHelp";
import { ActionGuide } from "@/components/onboarding/ActionGuide";
import { ModuleSwitcher } from "@/components/onboarding/ModuleSwitcher";
import { InlineError } from "@/components/ui/states";
import {
  canAccessAdmin,
  canAccessApp,
  getAccessContext,
} from "@/lib/onboarding/access";
import { loadUiGuideTexts } from "@/lib/onboarding/uiGuideTexts";
import { MODULE_LABELS } from "@/lib/onboarding/appProfileTypes";

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const access = await getAccessContext();
  const sp = await searchParams;
  const guides = await loadUiGuideTexts(["home.admin", "home.app"]);
  const isAdmin = access ? canAccessAdmin(access) : false;
  const hasAppAccess = access ? canAccessApp(access) : false;
  const isUserOnly = access?.role === "user";

  return (
    <div className="min-h-screen pb-safe">
      <AppHeader
        roleLabel={access?.roleLabel}
        agentTitle={access?.agentTitle}
        logoUrl={access?.customerLogoUrl}
      />
      <main className="page-shell mx-auto w-full max-w-5xl space-y-4 px-4 py-5 sm:space-y-5 sm:px-6 sm:py-8">
        {sp.error ? (
          <InlineError title="Aktion fehlgeschlagen" message={sp.error} />
        ) : null}

        <section className="panel compact flex items-start gap-3 p-4 sm:p-5">
          <div className="min-w-0 flex-1">
            <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">
              {access?.displayName ?? access?.email ?? "Willkommen"}
            </h1>
            <p className="muted mt-1 text-sm">
              {access?.roleLabel ?? "Gast"}
              {access?.customerName ? ` · ${access.customerName}` : ""}
              {access
                ? ` · ${MODULE_LABELS[access.activeModule]}`
                : ""}
            </p>
          </div>
        </section>

        {isAdmin ? (
          <section className="panel compact space-y-3 p-4 sm:p-5">
            <div>
              <h2 className="text-lg font-semibold">Nächster Schritt</h2>
              <p className="muted mt-1 text-sm">
                {access?.isGeneralAdmin
                  ? "Kunden, Fahrpläne und Freigaben steuern."
                  : `Onboarding und Pipeline für ${access?.customerName ?? "Ihr Projekt"}.`}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Link href="/admin/dashboard" className="btn btn-primary inline-flex">
                Zum Admin-Dashboard
              </Link>
              {hasAppAccess ? (
                <Link href="/app/ask" className="btn btn-secondary inline-flex">
                  Zur Fragen-Seite
                </Link>
              ) : null}
            </div>
            <ActionGuide guide={guides.get("home.admin")} />
          </section>
        ) : null}

        {!isAdmin && isUserOnly && hasAppAccess ? (
          <section className="panel compact space-y-3 p-4 sm:p-5">
            <div>
              <h2 className="text-lg font-semibold">Nächster Schritt</h2>
              <p className="muted mt-1 text-sm">
                Suche und Quellen für {access?.customerName ?? "Ihr Projekt"}.
              </p>
            </div>
            <Link href="/app/ask" className="btn btn-primary inline-flex">
              Zur Fragen-Seite
            </Link>
            <ActionGuide guide={guides.get("home.app")} />
          </section>
        ) : null}

        {!isAdmin && isUserOnly && !hasAppAccess ? (
          <section className="panel compact space-y-2 p-4 sm:p-5">
            <h2 className="text-lg font-semibold">Kein Projekt zugeordnet</h2>
            <p className="muted text-sm">
              Ihr Konto ist angemeldet, aber noch keinem Kundenprojekt
              zugewiesen. Bitte einen Admin um Freischaltung bitten.
            </p>
          </section>
        ) : null}

        {access && !isAdmin && !isUserOnly ? (
          <section className="panel compact space-y-2 p-4 sm:p-5">
            <h2 className="text-lg font-semibold">Eingeschränkter Zugang</h2>
            <p className="muted text-sm">
              Für dieses Konto ist derzeit kein Admin- oder Anwenderzugang
              freigeschaltet.
            </p>
          </section>
        ) : null}

        {access && (access.role === "general_admin" || access.role === "admin") ? (
          <ModuleSwitcher
            activeModule={access.activeModule}
            moduleSap={access.moduleSap}
            moduleHomepage={access.moduleHomepage}
            moduleDatabase={access.moduleDatabase}
          />
        ) : null}

        <HomePwaHelp />

        {!access?.schemaReady ? (
          <div
            className="panel compact p-3 text-sm"
            style={{ background: "var(--accent-soft)" }}
          >
            <p className="font-semibold">Profil-Schema noch nicht aktiv</p>
            <p className="muted mt-1">
              Bitte die Profil-Migration in Supabase anwenden und die Seite neu
              laden.
            </p>
          </div>
        ) : null}
      </main>
    </div>
  );
}
