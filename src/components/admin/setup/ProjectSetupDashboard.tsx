import Link from "next/link";
import { EmptyState, InlineError } from "@/components/ui/states";
import { PressNavigateLink } from "@/components/ui/PressNavigateLink";
import { SetupOverallProgress } from "@/components/admin/setup/SetupOverallProgress";
import { SetupStepCard } from "@/components/admin/setup/SetupStepCard";
import { WerkzeugePanel } from "@/components/admin/tools/WerkzeugePanel";
import type { SetupOverview } from "@/lib/admin/setupMainSteps";
import {
  applyDashboardDemoOverview,
  demoDisplayName,
  demoListPercent,
  sortProjectsForDemoDisplay,
} from "@/lib/admin/dashboardDemoDisplay";

export type ProjectSetupDashboardCustomer = {
  id: string;
  name: string;
};

export type ProjectSetupDashboardProps = {
  title?: string;
  /** Base path for project switcher links (e.g. `/app` or `/admin/dashboard`). */
  switchBasePath: string;
  projects: ProjectSetupDashboardCustomer[];
  selectedCustomer: ProjectSetupDashboardCustomer | null;
  overview: SetupOverview | null;
  /** Real list-bar percents for non-demo projects (e.g. DGL), keyed by customer id. */
  listPercents?: Record<string, number>;
  readOnlyUser?: boolean;
  /** Show project list (General Admin: all; Project Admin / Anwender: scoped). */
  showProjectList?: boolean;
  /** General Admin only — create project CTA. */
  showNewProject?: boolean;
  /** Projekt-Admin / General Admin — project admin link. */
  showProjectAdmin?: boolean;
  /** Allow status sync action. */
  canMutateStatus?: boolean;
  /** Empty-project CTA when list is shown but empty (General Admin). */
  emptyProjectsActionHref?: string;
  emptyProjectsActionLabel?: string;
  errorMessage?: string | null;
  deletedMessage?: boolean;
};

function currentStatusText(overview: SetupOverview): string {
  if (overview.nextStepId != null) {
    const step = overview.steps.find((s) => s.id === overview.nextStepId);
    if (step) return step.title;
  }
  return "Alle Hauptschritte erledigt";
}

function ProjectListProgress({ percent }: { percent: number | null }) {
  if (percent == null) return null;
  return (
    <div className="mt-1.5 w-full">
      <div
        className="progress-track h-1.5 overflow-hidden rounded-full"
        role="progressbar"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Projektfortschritt"
      >
        <div
          className={`h-full rounded-full ${
            percent >= 100 ? "progress-fill-done" : "progress-fill"
          }`}
          style={{ width: `${percent}%` }}
        />
      </div>
      <p className="mt-0.5 text-right text-[0.75rem] tabular-nums text-[var(--muted)]">
        {percent}&nbsp;%
      </p>
    </div>
  );
}

/**
 * Projektstatus + 6 Hauptschritte dashboard for Admin `/admin/dashboard`.
 * Anwender `/app` uses only SetupOverallProgress, not this full layout.
 */
export function ProjectSetupDashboard({
  title = "Dashboard",
  switchBasePath,
  projects,
  selectedCustomer,
  overview,
  listPercents = {},
  readOnlyUser = false,
  showProjectList = false,
  showNewProject = false,
  showProjectAdmin = false,
  canMutateStatus = false,
  emptyProjectsActionHref = "/admin/setup",
  emptyProjectsActionLabel = "Neues Projekt anlegen",
  errorMessage,
  deletedMessage = false,
}: ProjectSetupDashboardProps) {
  const customerId = selectedCustomer?.id;
  const orderedProjects = sortProjectsForDemoDisplay(projects);
  const displayOverview =
    selectedCustomer && overview
      ? applyDashboardDemoOverview(selectedCustomer.name, overview)
      : overview;
  const hasSetup = Boolean(customerId && selectedCustomer && displayOverview);
  const selectedDisplayName = selectedCustomer
    ? demoDisplayName(selectedCustomer.name)
    : null;

  const currentProjectBlock =
    hasSetup && selectedCustomer && displayOverview ? (
      <section className="admin-card project-current rounded-[12px] border p-3">
        <div className="flex items-baseline justify-between gap-2">
          <p className="text-[0.875rem] font-medium text-[var(--muted)]">
            Aktuelles Projekt
          </p>
          <span className="project-current-label">Aktuell</span>
        </div>
        <h2 className="mt-0.5 text-[1.25rem] font-medium leading-snug tracking-tight break-words text-[var(--foreground)]">
          {selectedDisplayName}
        </h2>
        <p className="mt-0.5 text-[0.875rem] text-[var(--muted)] break-words">
          Status: {currentStatusText(displayOverview)}
        </p>
        {readOnlyUser ? (
          <p className="mt-2 text-[0.9375rem] text-[var(--muted)]">
            Ansicht für Projekt-Benutzer — Aktionen erledigt der Projekt-Admin.
          </p>
        ) : null}
        {displayOverview.localDataError ? (
          <p className="mt-2 text-[0.9375rem] text-[var(--danger)] break-words">
            {displayOverview.localDataError}
          </p>
        ) : null}
      </section>
    ) : null;

  return (
    <div className="space-y-3">
      <h1 className="text-[1.5rem] font-semibold tracking-tight sm:text-[1.75rem]">
        {title}
      </h1>

      {errorMessage ? (
        <InlineError title="Aktion fehlgeschlagen" message={errorMessage} />
      ) : null}
      {deletedMessage ? (
        <div className="rounded-[12px] border border-[var(--border)] bg-[var(--panel)] p-3 text-[1.0625rem]">
          Projekt wurde gelöscht.
        </div>
      ) : null}

      {showProjectList ? (
        <section className="admin-card rounded-[12px] border border-[var(--border)] bg-[var(--panel)] p-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="text-[0.875rem] font-medium text-[var(--muted)]">
              Projekte
            </p>
            {showNewProject ? (
              <PressNavigateLink
                href="/admin/setup"
                className="btn-secondary-blue"
              >
                Neues Projekt anlegen
              </PressNavigateLink>
            ) : null}
          </div>

          {!orderedProjects.length ? (
            showNewProject ? (
              <EmptyState
                title="Noch kein Projekt"
                message="Legen Sie das erste Projekt an"
                actionHref={emptyProjectsActionHref}
                actionLabel={emptyProjectsActionLabel}
              />
            ) : (
              <EmptyState
                title="Kein Projekt zugeordnet"
                message="Ihrem Konto ist noch kein Kundenprojekt zugewiesen"
              />
            )
          ) : (
            <ul className="mt-2 space-y-2">
              {orderedProjects.map((c) => {
                const current = c.id === customerId;
                const fakePct = demoListPercent(c.name);
                const listPct =
                  fakePct ??
                  (typeof listPercents[c.id] === "number"
                    ? listPercents[c.id]!
                    : current && displayOverview
                      ? displayOverview.overallPercent
                      : null);
                return (
                  <li key={c.id}>
                    <Link
                      href={`${switchBasePath}?customer=${c.id}`}
                      className={`project-list-item block rounded-lg px-2.5 py-2 text-[1.0625rem] transition-[border-color,background] ${
                        current
                          ? "project-current font-medium text-[var(--foreground)]"
                          : "text-[var(--foreground)]"
                      }`}
                    >
                      <div className="flex min-h-8 items-center justify-between gap-2">
                        <span className="min-w-0 break-words">
                          {demoDisplayName(c.name)}
                        </span>
                        {current ? (
                          <span className="project-current-label shrink-0">
                            Aktuell
                          </span>
                        ) : null}
                      </div>
                      <ProjectListProgress percent={listPct} />
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      ) : (
        currentProjectBlock
      )}

      {hasSetup && selectedCustomer && displayOverview ? (
        <>
          {showProjectList ? currentProjectBlock : null}

          <SetupOverallProgress
            percent={displayOverview.overallPercent}
            doneCount={displayOverview.doneCount}
            totalCount={displayOverview.totalCount}
            sentence={displayOverview.overallSentence}
          />

          <section className="space-y-1.5">
            <p className="text-[0.8125rem] font-medium text-[var(--muted)]">
              Hauptschritte
            </p>
            <ol className="space-y-1.5">
              {displayOverview.steps.map((step) => (
                <li key={step.id}>
                  <SetupStepCard step={step} />
                </li>
              ))}
            </ol>
          </section>

          <WerkzeugePanel
            customerId={selectedCustomer.id}
            canMutate={canMutateStatus}
          />

          {showProjectAdmin ? (
            <PressNavigateLink
              href={`/admin/project?customer=${selectedCustomer.id}`}
              className="btn-project-admin"
            >
              Projekt-Administration
            </PressNavigateLink>
          ) : null}
        </>
      ) : !showProjectList ? (
        <EmptyState
          title="Kein Projekt zugeordnet"
          message="Ihrem Konto ist noch kein Kundenprojekt zugewiesen"
        />
      ) : null}
    </div>
  );
}
