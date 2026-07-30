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
    <form action={switchActiveModuleAction} className="panel compact space-y-3 p-4">
      <div>
        <h2 className="text-base font-semibold">Modul</h2>
        <p className="muted mt-0.5 text-xs">
          Setzt Titel und Fokus der Oberfläche.
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
              key === activeModule
                ? "btn btn-primary px-3 text-sm"
                : "btn btn-secondary px-3 text-sm"
            }
            aria-pressed={key === activeModule}
          >
            {MODULE_LABELS[key]}
          </button>
        ))}
      </div>
    </form>
  );
}
