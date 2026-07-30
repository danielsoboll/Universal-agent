import Link from "next/link";
import { AppHeader } from "@/components/AppHeader";
import { BrandMark } from "@/components/brand/BrandMark";
import { PwaInstallPanel } from "@/components/pwa/PwaInstallPanel";
import { ActionGuide } from "@/components/onboarding/ActionGuide";
import { ModuleSwitcher } from "@/components/onboarding/ModuleSwitcher";
import {
  canAccessAdmin,
  getAccessContext,
} from "@/lib/onboarding/access";
import { loadUiGuideTexts } from "@/lib/onboarding/uiGuideTexts";
import { MODULE_LABELS } from "@/lib/onboarding/appProfileTypes";

export default async function HomePage() {
  const access = await getAccessContext();
  const guides = await loadUiGuideTexts(["home.admin", "home.app"]);
  const isAdmin = access ? canAccessAdmin(access) : false;
  const isUserOnly = access?.role === "user";

  return (
    <>
      <AppHeader
        roleLabel={access?.roleLabel}
        agentTitle={access?.agentTitle}
        logoUrl={access?.customerLogoUrl}
      />
      <main className="mx-auto w-full max-w-5xl space-y-8 px-6 py-8">
        <section className="panel flex flex-col items-start gap-4 p-6 sm:flex-row sm:items-center">
          <BrandMark
            size={64}
            href={null}
            title={access?.agentTitle}
            logoUrl={access?.customerLogoUrl}
          />
          <div className="min-w-0 flex-1">
            <p className="hero-kicker">{access?.agentTagline ?? "Universal Knowledge Analyzer"}</p>
            <h1 className="mt-1 text-3xl font-semibold tracking-tight">
              {access?.agentTitle ?? "General Agent"}
            </h1>
            {access ? (
              <dl className="mt-3 grid gap-1 text-sm sm:grid-cols-2">
                <div>
                  <dt className="muted">Profil</dt>
                  <dd className="font-medium">{access.roleLabel}</dd>
                </div>
                <div>
                  <dt className="muted">Konto</dt>
                  <dd className="font-medium">{access.displayName ?? access.email}</dd>
                </div>
                {access.customerName ? (
                  <div>
                    <dt className="muted">Kunde</dt>
                    <dd className="font-medium">{access.customerName}</dd>
                  </div>
                ) : null}
                <div>
                  <dt className="muted">Aktives Modul</dt>
                  <dd className="font-medium">
                    {MODULE_LABELS[access.activeModule]}
                  </dd>
                </div>
              </dl>
            ) : (
              <p className="muted mt-2 text-sm">
                Melden Sie sich mit bestehendem Konto an. Das Profil kommt aus Supabase.
              </p>
            )}
          </div>
        </section>

        {access && (access.role === "general_admin" || access.role === "admin") ? (
          <ModuleSwitcher
            activeModule={access.activeModule}
            moduleSap={access.moduleSap}
            moduleHomepage={access.moduleHomepage}
            moduleDatabase={access.moduleDatabase}
          />
        ) : null}

        <section className="panel space-y-4 p-6">
          <div>
            <p className="hero-kicker">Home-Bildschirm</p>
            <h2 className="mt-1 text-xl font-semibold">Zum Home-Bildschirm hinzufügen</h2>
            <p className="muted mt-1 text-sm">
              Schneller Start ohne Browser-Leiste — Anleitung je nach Gerät.
            </p>
          </div>
          <PwaInstallPanel />
        </section>

        {isAdmin ? (
          <section className="panel space-y-4 p-6">
            <p className="hero-kicker">Ihr Bereich</p>
            <h2 className="text-xl font-semibold">
              {access?.isGeneralAdmin ? "General Admin" : "Admin"}
            </h2>
            <p className="muted text-sm">
              {access?.isGeneralAdmin
                ? "Plattformweite Steuerung: Kunden, Adapter, Fahrpläne und Freigaben."
                : `Kundenprojekt ${access?.customerName ?? ""} — Onboarding und Pipeline.`}
            </p>
            <Link href="/admin/dashboard" className="btn btn-primary inline-flex">
              Zum Admin-Dashboard
            </Link>
            <ActionGuide guide={guides.get("home.admin")} />
          </section>
        ) : null}

        {isUserOnly ? (
          <section className="panel space-y-4 p-6">
            <p className="hero-kicker">Ihr Bereich</p>
            <h2 className="text-xl font-semibold">Anwender</h2>
            <p className="muted text-sm">
              Suche und Quellen für {access?.customerName ?? "Ihr Projekt"}. Keine
              Admin-Rechte.
            </p>
            <Link href="/app/search" className="btn btn-primary inline-flex">
              Zur Suche
            </Link>
            <ActionGuide guide={guides.get("home.app")} />
          </section>
        ) : null}

        {!access?.schemaReady ? (
          <div className="panel p-4 text-sm" style={{ background: "var(--accent-soft)" }}>
            <p className="font-semibold">Profil-Schema noch nicht aktiv</p>
            <p className="muted mt-1">
              Migration <code>20260731000600_app_user_profiles.sql</code> in Supabase
              anwenden, danach Profil für Ihren User prüfen.
            </p>
          </div>
        ) : null}
      </main>
    </>
  );
}
