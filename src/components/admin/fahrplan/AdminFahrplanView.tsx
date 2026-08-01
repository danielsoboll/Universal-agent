import { WORKFLOW_PHASES, phaseTitle } from "@/lib/onboarding/phases";
import {
  computeDisplayProgress,
  executionHint,
  findNextActionableStep,
  getStepDisplayStatus,
  softenShortDescription,
} from "@/lib/onboarding/stepDisplay";
import {
  FahrplanStepCard,
  type FahrplanStepRow,
} from "@/components/admin/fahrplan/FahrplanStepCard";

type Guide = { title?: string; body?: string };

export function AdminFahrplanView({
  customerId,
  projectName,
  workflow,
  steps,
  guideComplete,
  guidePipeline,
}: {
  customerId: string;
  projectName: string;
  workflow: {
    template_key: string;
    template_version: string;
    summary: string | null;
    generated_from_goal_ids?: string[] | null;
    generated_from_adapter_ids?: string[] | null;
  };
  steps: FahrplanStepRow[];
  guideComplete?: Guide;
  guidePipeline?: Guide;
}) {
  const progress = computeDisplayProgress(steps);
  const next = findNextActionableStep(steps);
  const nextDisplay = next ? getStepDisplayStatus(next) : null;
  const activePhaseKey = next?.phase_key ?? steps.find((s) => {
    const d = getStepDisplayStatus(s);
    return d !== "completed" && d !== "skipped";
  })?.phase_key ?? null;

  const phaseOrder = new Map(WORKFLOW_PHASES.map((p) => [p.key, p.order]));
  const presentPhases = [
    ...new Set(steps.map((s) => s.phase_key).filter(Boolean)),
  ].sort((a, b) => (phaseOrder.get(a) ?? 99) - (phaseOrder.get(b) ?? 99));

  const phaseStrip = WORKFLOW_PHASES.filter((p) =>
    presentPhases.includes(p.key),
  );

  const nextRecommendation = next
    ? softenShortDescription(next.short_description) ||
      next.title
    : progress.percent >= 100
      ? "Alle Schritte erledigt"
      : "Kein ausführbarer Schritt — prüfen Sie Voraussetzungen oder Setup";

  return (
    <div className="space-y-3 sm:space-y-4">
      <header className="space-y-0.5">
        <h1 className="admin-page-title">
          Fahrplan
        </h1>
        <p className="text-sm font-medium sm:text-base">{projectName}</p>
      </header>

      <section className="panel compact space-y-3 p-3 sm:p-4">
        <div className="space-y-2">
          <div className="flex items-end justify-between gap-3">
            <div>
              <p className="text-xs text-[var(--muted)]">Fortschritt</p>
              <p className="text-lg font-semibold leading-tight sm:text-xl">
                {progress.percent}%
              </p>
            </div>
            <p className="text-right text-xs text-[var(--muted)] sm:text-sm">
              {progress.completed} von {progress.total} Schritten abgeschlossen
            </p>
          </div>
          <div
            className="progress-track h-2 overflow-hidden rounded-full"
            role="progressbar"
            aria-valuenow={progress.percent}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div
              className="h-full rounded-full bg-[var(--accent)] transition-all"
              style={{ width: `${progress.percent}%` }}
            />
          </div>
        </div>

        <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
          <div className="rounded-md bg-[var(--surface-raised)] px-2.5 py-2">
            <dt className="text-[0.65rem] text-[var(--muted)] sm:text-xs">
              Erledigt
            </dt>
            <dd className="font-semibold">{progress.completed}</dd>
          </div>
          <div className="rounded-md bg-[var(--surface-raised)] px-2.5 py-2">
            <dt className="text-[0.65rem] text-[var(--muted)] sm:text-xs">
              Bereit
            </dt>
            <dd className="font-semibold">{progress.ready}</dd>
          </div>
          <div className="rounded-md bg-[var(--surface-raised)] px-2.5 py-2">
            <dt className="text-[0.65rem] text-[var(--muted)] sm:text-xs">
              Wartet
            </dt>
            <dd className="font-semibold">{progress.waiting}</dd>
          </div>
          <div className="rounded-md bg-[var(--surface-raised)] px-2.5 py-2">
            <dt className="text-[0.65rem] text-[var(--muted)] sm:text-xs">
              Blockiert
            </dt>
            <dd className="font-semibold">{progress.blocked}</dd>
          </div>
        </dl>

        <div>
          <p className="text-xs text-[var(--muted)]">Nächste empfohlene Aktion</p>
          <p className="text-sm font-medium leading-snug sm:text-[0.95rem]">
            {next
              ? `${next.title} · ${executionHint(next)}`
              : nextRecommendation}
          </p>
        </div>

        {phaseStrip.length > 0 ? (
          <div className="-mx-1 overflow-x-auto px-1 pb-0.5">
            <ol className="flex min-w-min gap-1.5">
              {phaseStrip.map((phase) => {
                const active = phase.key === activePhaseKey;
                const phaseSteps = steps.filter((s) => s.phase_key === phase.key);
                const done = phaseSteps.filter((s) => {
                  const d = getStepDisplayStatus(s);
                  return d === "completed" || d === "skipped";
                }).length;
                return (
                  <li key={phase.key}>
                    <span
                      className={`inline-flex items-center gap-1 whitespace-nowrap rounded-md px-2 py-1 text-[0.65rem] sm:text-xs ${
                        active
                          ? "bg-[var(--accent-soft)] font-semibold text-[var(--accent)] ring-1 ring-[color-mix(in_srgb,var(--accent)_30%,transparent)]"
                          : "bg-[var(--surface-raised)] text-[var(--muted)]"
                      }`}
                    >
                      {phase.title}
                      <span className="opacity-70">
                        {done}/{phaseSteps.length}
                      </span>
                    </span>
                  </li>
                );
              })}
            </ol>
          </div>
        ) : null}

        <details className="text-sm">
          <summary className="cursor-pointer text-xs font-medium text-[var(--muted)]">
            Technische Details
          </summary>
          <div className="mt-2 space-y-1 rounded-md border border-[var(--border)] bg-[var(--surface-raised)] p-2.5 text-xs text-[var(--muted)]">
            <p>
              Vorlage: {workflow.template_key} v{workflow.template_version}
            </p>
            {workflow.summary ? (
              <p className="leading-snug">{workflow.summary}</p>
            ) : null}
            {workflow.generated_from_goal_ids?.length ? (
              <p className="break-all">
                Ziel-IDs: {workflow.generated_from_goal_ids.join(", ")}
              </p>
            ) : null}
            {workflow.generated_from_adapter_ids?.length ? (
              <p className="break-all">
                Adapter-IDs: {workflow.generated_from_adapter_ids.join(", ")}
              </p>
            ) : null}
          </div>
        </details>
      </section>

      {next ? (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold tracking-tight">
            Nächster Schritt
          </h2>
          <FahrplanStepCard
            step={next}
            customerId={customerId}
            displayStatus={nextDisplay ?? undefined}
            variant="next"
            defaultDetailsOpen={false}
            guideComplete={guideComplete}
            guidePipeline={guidePipeline}
            showPrimaryActions
          />
        </section>
      ) : null}

      <div className="space-y-2.5">
        {presentPhases.map((phaseKey) => {
          const phaseSteps = steps
            .filter((s) => s.phase_key === phaseKey)
            .sort((a, b) => a.sort_order - b.sort_order);
          const done = phaseSteps.filter((s) => {
            const d = getStepDisplayStatus(s);
            return d === "completed" || d === "skipped";
          }).length;
          const isActive = phaseKey === activePhaseKey;

          return (
            <details
              key={phaseKey}
              className="panel compact group/phase"
              open={isActive}
            >
              <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-3 py-2.5 sm:px-4">
                <h2 className="text-sm font-semibold sm:text-base">
                  {phaseTitle(phaseKey)}
                  {isActive ? (
                    <span className="ml-2 text-[0.65rem] font-medium text-[var(--accent)] sm:text-xs">
                      aktuell
                    </span>
                  ) : null}
                </h2>
                <span className="shrink-0 text-xs text-[var(--muted)]">
                  {done}/{phaseSteps.length}
                </span>
              </summary>
              <div className="space-y-2 border-t border-[var(--border)] px-2 py-2 sm:px-3">
                {phaseSteps.map((step) => {
                  const display = getStepDisplayStatus(step);
                  // Nächster Schritt steht oben als Primärkarte — in der Phase nur kompakt verlinken.
                  if (next?.id === step.id) {
                    return (
                      <p
                        key={step.id}
                        className="rounded-md bg-[var(--accent-soft)] px-3 py-2 text-xs text-[var(--accent)] sm:text-sm"
                      >
                        Aktuell oben hervorgehoben: {step.title}
                      </p>
                    );
                  }
                  return (
                    <FahrplanStepCard
                      key={step.id}
                      step={step}
                      customerId={customerId}
                      displayStatus={display}
                      variant="list"
                      defaultDetailsOpen={false}
                      guideComplete={guideComplete}
                      guidePipeline={guidePipeline}
                      showPrimaryActions={false}
                    />
                  );
                })}
              </div>
            </details>
          );
        })}
      </div>
    </div>
  );
}
