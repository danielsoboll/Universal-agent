import Link from "next/link";
import { AppHeader } from "@/components/AppHeader";
import { HomePwaHelp } from "@/components/home/HomePwaHelp";
import { InlineError } from "@/components/ui/states";
import {
  canAccessAdmin,
  canAccessApp,
  canAccessProjectConsole,
  getAccessContext,
} from "@/lib/onboarding/access";
import { MODULE_LABELS } from "@/lib/onboarding/appProfileTypes";
import { resolveShellBranding } from "@/lib/onboarding/projectBranding";

function RoleArrowIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M5 12h14" />
      <path d="m12 5 7 7-7 7" />
    </svg>
  );
}

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const access = await getAccessContext();
  const sp = await searchParams;
  const isAdmin = access ? canAccessAdmin(access) : false;
  const canConsole = access ? canAccessProjectConsole(access) : false;
  const hasAppAccess = access ? canAccessApp(access) : false;
  const isUserOnly = access?.role === "user";
  const branding = access
    ? resolveShellBranding({
        isGeneralAdmin: access.isGeneralAdmin || access.isPlatformAdmin,
        customerName: access.customerName,
        customerLogoUrl: access.customerLogoUrl,
        fallbackTitle: access.agentTitle,
      })
    : null;

  return (
    <div className="min-h-screen pb-safe">
      <AppHeader
        agentTitle={branding?.title ?? access?.agentTitle}
        logoUrl={branding?.logoUrl ?? null}
      />
      <main className="page-shell mx-auto flex w-full max-w-5xl flex-col gap-3 px-4 py-4 sm:gap-4 sm:px-6 sm:py-6">
        {sp.error ? (
          <InlineError title="Aktion fehlgeschlagen" message={sp.error} />
        ) : null}

        <section className="panel compact home-user-role p-4 sm:p-5">
          <h1 className="text-[1.375rem] font-semibold leading-tight tracking-tight text-[color-mix(in_srgb,var(--warning)_42%,var(--foreground))] sm:text-[1.5rem] [overflow-wrap:anywhere]">
            {access?.displayName ?? access?.email ?? "Willkommen"}
          </h1>
          {access?.roleLabel ? (
            <p className="mt-1 text-[0.8125rem] text-[var(--muted)]">
              {access.role === "general_admin" || access.role === "admin" ? (
                <span className="home-role home-role--admin">
                  <span aria-hidden="true" className="home-role__arrow">
                    <RoleArrowIcon />
                  </span>
                  {access.roleLabel}
                </span>
              ) : (
                <span className="home-role home-role--keyuser">
                  <span aria-hidden="true" className="home-role__arrow">
                    <RoleArrowIcon />
                  </span>
                  Keyuser
                </span>
              )}
              {access.customerName
                ? ` · ${access.customerName}`
                : access.customerId
                  ? ` · ${MODULE_LABELS[access.productModule]}`
                  : ""}
            </p>
          ) : null}
        </section>

        {canConsole ? (
          <section className="panel compact space-y-3 p-4 sm:p-5">
            <div>
              <h2 className="text-[1.25rem] font-semibold tracking-tight">
                Nächster Schritt
              </h2>
              <p className="mt-1 text-[1.0625rem] leading-snug text-[var(--muted)]">
                {access?.isGeneralAdmin
                  ? "Projekt wählen und Datenimport-Schritte abarbeiten"
                  : isUserOnly
                    ? `Status und Details für ${access?.customerName ?? "Ihr Projekt"} einsehen`
                    : `Setup für ${access?.customerName ?? "Ihr Projekt"} fortsetzen`}
              </p>
            </div>
            <Link
              href={isUserOnly ? "/app" : "/admin/dashboard"}
              className="btn btn-primary flex min-h-12 w-full items-center justify-center text-[1.0625rem]"
            >
              Zum Dashboard
            </Link>
          </section>
        ) : null}

        {!isAdmin && isUserOnly && hasAppAccess ? (
          <section className="panel compact space-y-3 p-4 sm:p-5">
            <div>
              <h2 className="text-[1.25rem] font-semibold tracking-tight">
                Anwenderbereich
              </h2>
              <p className="mt-1 text-[1.0625rem] leading-snug text-[var(--muted)]">
                Fragen und Suche für{" "}
                {access?.customerName ?? "Ihr Projekt"}
                {access ? ` (${MODULE_LABELS[access.productModule]})` : ""}.
              </p>
            </div>
            <div className="flex flex-col gap-2">
              <Link
                href="/app/ask"
                className="btn btn-secondary btn-quiet flex min-h-12 w-full items-center justify-center"
              >
                Frage stellen
              </Link>
            </div>
          </section>
        ) : null}

        {!isAdmin && isUserOnly && !hasAppAccess ? (
          <section className="panel compact space-y-2 p-4 sm:p-5">
            <h2 className="text-[1.25rem] font-semibold">Kein Projekt zugeordnet</h2>
            <p className="text-[1.0625rem] text-[var(--muted)]">
              Ihr Konto ist angemeldet, aber noch keinem Kundenprojekt
              zugewiesen. Bitte einen Admin um Freischaltung bitten.
            </p>
          </section>
        ) : null}

        {access && !isAdmin && !isUserOnly ? (
          <section className="panel compact space-y-2 p-4 sm:p-5">
            <h2 className="text-[1.25rem] font-semibold">Eingeschränkter Zugang</h2>
            <p className="text-[1.0625rem] text-[var(--muted)]">
              Für dieses Konto ist derzeit kein Admin- oder Anwenderzugang
              freigeschaltet.
            </p>
          </section>
        ) : null}

        {!access ? (
          <section className="panel compact space-y-3 p-4 sm:p-5">
            <h2 className="text-[1.25rem] font-semibold">Anmelden</h2>
            <p className="text-[1.0625rem] text-[var(--muted)]">
              Fragen und Projektstatus sind erst nach Anmeldung und
              Projektzuordnung verfügbar.
            </p>
            <Link
              href="/login"
              className="btn btn-primary flex min-h-12 w-full items-center justify-center"
            >
              Zum Login
            </Link>
          </section>
        ) : null}

        <HomePwaHelp />

        {!access?.schemaReady && access ? (
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

        {access ? (
          <div className="mt-auto border-t border-[var(--border)] pt-4 pb-2">
            <form action="/auth/signout" method="post">
              <button
                type="submit"
                className="btn btn-secondary btn-quiet flex min-h-12 w-full items-center justify-center text-[1.0625rem]"
              >
                Abmelden
              </button>
            </form>
          </div>
        ) : null}
      </main>
    </div>
  );
}
