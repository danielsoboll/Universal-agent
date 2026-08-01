import { WorkflowStepCard } from "@/components/admin/WorkflowStepCard";
import { PressNavigateLink } from "@/components/ui/PressNavigateLink";
import type { getWorkflowViewModel } from "@/actions/workflow";
import { WORKFLOW_STATUS_LABELS } from "@/lib/workflow/types";
import { listUnconfiguredValues, buildPlaceholderMap } from "@/lib/workflow/placeholders";

type ViewModel = Awaited<ReturnType<typeof getWorkflowViewModel>>;

export function ExtractionChecklist({
  model,
  focusStepId,
  flash,
}: {
  model: ViewModel;
  focusStepId?: string;
  flash?: string;
}) {
  const { project, process, steps, summary } = model;
  const nextId = focusStepId || summary.nextStepId;
  const next = steps.find((s) => s.resolved.id === nextId) ?? null;

  const phases = new Map<string, typeof steps>();
  for (const s of steps) {
    const key = `${s.resolved.phase_order}::${s.resolved.phase}`;
    const list = phases.get(key) ?? [];
    list.push(s);
    phases.set(key, list);
  }

  const unconfigured = listUnconfiguredValues(buildPlaceholderMap(project));
  const blocked = steps.filter((s) => s.status === "blockiert");

  return (
    <div className="space-y-3 sm:space-y-4">
      <div>
        <h1 className="admin-page-title">
          {process.title}
        </h1>
      </div>

      {flash ? (
        <div
          className="panel compact p-3 text-sm"
          style={{ background: "var(--accent-soft)" }}
        >
          {flash}
        </div>
      ) : null}

      <section className="panel compact admin-card space-y-2 p-3 sm:p-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <p className="muted text-xs uppercase tracking-wide">Aktuelles Projekt</p>
            <h2 className="admin-card-title font-medium tracking-tight">{project.name}</h2>
            <p className="text-sm">
              {project.customer_id} / {project.system_id}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <PressNavigateLink href="/admin/project" className="btn btn-secondary text-xs">
              Projekt konfigurieren
            </PressNavigateLink>
            <PressNavigateLink href="/admin/users" className="btn btn-secondary text-xs">
              Benutzer
            </PressNavigateLink>
            <a
              href="/app"
              target="_blank"
              rel="noopener noreferrer"
              className="btn btn-secondary text-xs"
            >
              User-Ansicht
            </a>
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-4">
          <div>
            <p className="muted text-xs">Gesamtfortschritt</p>
            <p className="text-lg font-semibold">
              {summary.progressPercent}%{" "}
              <span className="muted text-sm font-normal">
                ({summary.completed}/{summary.total})
              </span>
            </p>
            <div className="mt-1 h-2 overflow-hidden rounded bg-[var(--border)]">
              <div
                className="h-full bg-[var(--accent)]"
                style={{ width: `${summary.progressPercent}%` }}
              />
            </div>
          </div>
          <div>
            <p className="muted text-xs">Nächster Schritt</p>
            <p className="text-sm font-medium">
              {next
                ? `${next.resolved.sequence}. ${next.resolved.title}`
                : "—"}
            </p>
          </div>
          <div>
            <p className="muted text-xs">Blockiert</p>
            <p className="text-sm font-medium">{summary.blocked}</p>
          </div>
          <div>
            <p className="muted text-xs">Letzte Prüfung</p>
            <p className="text-sm font-medium">
              {summary.lastCheckAt
                ? new Date(summary.lastCheckAt).toLocaleString("de-DE")
                : "—"}
            </p>
          </div>
        </div>

        {blocked.length > 0 ? (
          <div className="text-sm">
            <p className="muted text-xs">Blockierte Schritte</p>
            <ul className="mt-1 list-disc pl-5">
              {blocked.slice(0, 5).map((b) => (
                <li key={b.resolved.id}>
                  {b.resolved.sequence}. {b.resolved.title} (
                  {WORKFLOW_STATUS_LABELS[b.status]})
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {unconfigured.length > 0 ? (
          <p className="text-xs" style={{ color: "var(--danger)" }}>
            Noch zu konfigurieren: {unconfigured.join(", ")} — unter Projekt
            pflegen.
          </p>
        ) : null}
      </section>

      {next ? (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-[var(--muted)]">
            Jetzt ausführen
          </h2>
          <WorkflowStepCard
            projectId={project.id}
            step={next.resolved}
            state={next.state}
            status={next.status}
            defaultOpen
          />
        </section>
      ) : null}

      <div className="space-y-3">
        {[...phases.entries()].map(([key, phaseSteps]) => {
          const phaseName = key.split("::")[1] ?? key;
          const phaseOrder = key.split("::")[0];
          const done = phaseSteps.filter(
            (s) =>
              s.status === "abgeschlossen" || s.status === "uebersprungen",
          ).length;
          return (
            <details
              key={key}
              className="panel compact"
              open={phaseSteps.some((s) => s.resolved.id === nextId)}
            >
              <summary className="cursor-pointer list-none px-4 py-3">
                <div className="flex items-center justify-between gap-2">
                  <h2 className="text-base font-semibold">
                    <span className="muted mr-2 font-mono text-sm">
                      {phaseOrder}.
                    </span>
                    {phaseName}
                  </h2>
                  <span className="muted text-xs">
                    {done}/{phaseSteps.length}
                  </span>
                </div>
              </summary>
              <div className="space-y-2 border-t border-[var(--border)] px-2 py-2 sm:px-3">
                {phaseSteps.map((s) => (
                  <WorkflowStepCard
                    key={s.resolved.id}
                    projectId={project.id}
                    step={s.resolved}
                    state={s.state}
                    status={s.status}
                    defaultOpen={s.resolved.id === nextId}
                  />
                ))}
              </div>
            </details>
          );
        })}
      </div>
    </div>
  );
}
