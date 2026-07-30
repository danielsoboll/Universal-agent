import { switchActiveModuleAction } from "@/actions/profile";
import {
  MODULE_LABELS,
  type AppModuleKey,
  enabledModules,
} from "@/lib/onboarding/appProfileTypes";

export function ModuleSwitcher({
  activeModule,
  moduleSap,
  moduleHomepage,
  moduleDatabase,
}: {
  activeModule: AppModuleKey;
  moduleSap: boolean;
  moduleHomepage: boolean;
  moduleDatabase: boolean;
}) {
  const modules = enabledModules({
    moduleSap,
    moduleHomepage,
    moduleDatabase,
  });

  if (modules.length <= 1) return null;

  return (
    <form action={switchActiveModuleAction} className="panel space-y-3 p-5">
      <div>
        <p className="hero-kicker">Produktmodus</p>
        <h2 className="mt-1 text-lg font-semibold">Modul wählen</h2>
        <p className="muted mt-1 text-sm">
          Häkchen kommen aus Ihrem Supabase-Profil. Die Auswahl setzt Titel und
          Fokus der App (z.&nbsp;B. SAP Analyse Agent).
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        {modules.map((key) => (
          <button
            key={key}
            type="submit"
            name="module"
            value={key}
            className={
              key === activeModule ? "btn btn-primary" : "btn btn-secondary"
            }
            aria-pressed={key === activeModule}
          >
            {MODULE_LABELS[key]}
            {key === activeModule ? " ✓" : ""}
          </button>
        ))}
      </div>
      <ul className="muted space-y-1 text-xs">
        <li>SAP: {moduleSap ? "aktiv" : "nicht freigeschaltet"}</li>
        <li>Homepage: {moduleHomepage ? "aktiv" : "nicht freigeschaltet"}</li>
        <li>Datenbank: {moduleDatabase ? "aktiv" : "nicht freigeschaltet"}</li>
      </ul>
    </form>
  );
}
