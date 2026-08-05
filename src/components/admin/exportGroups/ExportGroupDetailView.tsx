import type { ExportGroupState, FlowPoint, PointStatus } from "@/lib/admin/exportGroups/types";
import { StatusStatusButton } from "@/components/admin/fahrplan/CompactStatus";
import { OrgConfirmButton } from "@/components/admin/exportGroups/OrgConfirmButton";
import type { FahrplanStepStatus } from "@/lib/rebuild/controlTablesFahrplanTypes";

function pointToTone(status: PointStatus): FahrplanStepStatus {
  switch (status) {
    case "done":
      return "success";
    case "error":
      return "failed";
    case "in_progress":
      return "running";
    case "locked":
      return "not_available";
    case "open":
    default:
      return "ready";
  }
}

function pointLabel(status: PointStatus): string {
  switch (status) {
    case "done":
      return "Erledigt";
    case "error":
      return "Fehler";
    case "in_progress":
      return "Läuft";
    case "locked":
      return "Gesperrt";
    case "open":
    default:
      return "Offen";
  }
}

function PointRow({
  point,
  projectKey,
  groupId,
  canMutate,
  showConfirm,
}: {
  point: FlowPoint;
  projectKey: string;
  groupId: string;
  canMutate: boolean;
  showConfirm: boolean;
}) {
  const tone = pointToTone(point.status);
  return (
    <li className="flex items-start gap-2 border-b border-[var(--border)] py-2.5 last:border-b-0">
      <div className="min-w-0 flex-1">
        <p className="text-[1.0625rem] font-medium leading-snug break-words">
          {point.label}
        </p>
        {point.detail ? (
          <p className="mt-0.5 text-[0.8125rem] leading-snug text-[var(--muted)] break-words">
            {point.detail}
          </p>
        ) : null}
      </div>
      {showConfirm && point.confirmable && point.kind === "org" ? (
        <OrgConfirmButton
          projectKey={projectKey}
          groupId={groupId}
          pointKey={point.id}
          confirmed={point.status === "done"}
          canRun={canMutate}
        />
      ) : (
        <StatusStatusButton
          status={tone}
          label={pointLabel(point.status)}
          className="shrink-0 !min-h-0 !px-2 !py-1 !text-[0.8125rem] !font-medium"
        />
      )}
    </li>
  );
}

/** Detail frame for one export group under Area 3 / 4 / 5. */
export function ExportGroupDetailView({
  group,
  stepId,
  projectKey,
  canMutate,
  children,
}: {
  group: ExportGroupState;
  stepId: 3 | 4 | 5;
  projectKey: string;
  canMutate: boolean;
  children?: React.ReactNode;
}) {
  const percent =
    stepId === 3
      ? group.progressPercent
      : stepId === 4
        ? group.validation.progressPercent
        : group.feintuning.progressPercent;
  const locked =
    stepId === 4
      ? group.validation.locked
      : stepId === 5
        ? group.feintuning.locked
        : false;
  const overallStatus: PointStatus = locked
    ? "locked"
    : percent >= 100
      ? "done"
      : group.technicalStatus === "error"
        ? "error"
        : percent > 0
          ? "in_progress"
          : "open";

  const showZyDetail = stepId === 3 && group.id === "zy-tables";
  const stagePoints: FlowPoint[] =
    stepId === 3
      ? showZyDetail
        ? group.recognitionDetail
        : []
      : stepId === 4
        ? group.validation.stages.map((s) => ({
            id: s.id,
            label: s.label,
            kind: "tech" as const,
            status: s.status,
            detail: s.detail,
          }))
        : group.feintuning.stages.map((s) => ({
            id: s.id,
            label: s.label,
            kind: "tech" as const,
            status: s.status,
            detail: s.detail,
          }));

  const sectionTitle =
    stepId === 3
      ? "Z-/Y-Erkennung"
      : stepId === 4
        ? "Validierungsstufen"
        : "Feintuning-Stufen";

  return (
    <div className="space-y-3">
      <header className="min-w-0">
        <p className="text-[0.8125rem] font-medium tabular-nums text-[var(--muted)]">
          {stepId === 3
            ? "Datenbasis"
            : stepId === 4
              ? "Validierung"
              : "Export Teil 2 / Feintuning"}
        </p>
        <h1 className="mt-0.5 text-[1.5rem] font-semibold leading-snug tracking-tight break-words sm:text-[1.75rem]">
          {group.title}
        </h1>
        <p className="mt-1 text-[1.0625rem] leading-snug text-[var(--muted)] break-words">
          {group.description}
        </p>
        <p className="mt-1.5 text-[0.9375rem] font-medium tabular-nums text-[var(--muted)]">
          Fortschritt {percent}&nbsp;%
        </p>
      </header>

      <section className="admin-card rounded-[12px] border border-[var(--border)] bg-[var(--panel)] p-3">
        <div className="flex items-start justify-between gap-2">
          <p className="text-[0.875rem] font-medium text-[var(--muted)]">
            Status
          </p>
          <StatusStatusButton
            status={pointToTone(overallStatus)}
            label={pointLabel(overallStatus)}
            className="shrink-0 !min-h-0 !px-2 !py-1 !text-[0.8125rem] !font-medium"
          />
        </div>
        <div
          className="progress-track mt-2 h-2 overflow-hidden rounded-full"
          role="progressbar"
          aria-valuenow={percent}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div
            className={`h-full rounded-full ${
              overallStatus === "error"
                ? "progress-fill-error"
                : overallStatus === "done"
                  ? "progress-fill-done"
                  : locked
                    ? "progress-fill-locked"
                    : "progress-fill"
            }`}
            style={{ width: `${percent}%` }}
          />
        </div>
        <p className="mt-2 text-[1.0625rem] leading-snug break-words">
          {locked
            ? stepId === 4
              ? "Gesperrt — Gruppe in Datenbasis noch nicht vollständig erkannt"
              : "Gesperrt — Validierung dieser Gruppe noch nicht abgeschlossen"
            : group.nextAction}
        </p>
      </section>

      {stepId === 3 ? (
        <section className="admin-card rounded-[12px] border border-[var(--border)] bg-[var(--panel)] px-3 py-1">
          <p className="pt-2 text-[0.875rem] font-medium text-[var(--muted)]">
            Ablauf
          </p>
          <ol className="mt-0.5">
            {group.operationalFlow.map((point) => (
              <PointRow
                key={point.id}
                point={point}
                projectKey={projectKey}
                groupId={group.id}
                canMutate={canMutate}
                showConfirm
              />
            ))}
          </ol>
        </section>
      ) : null}

      {stagePoints.length > 0 ? (
        <section className="admin-card rounded-[12px] border border-[var(--border)] bg-[var(--panel)] px-3 py-1">
          <p className="pt-2 text-[0.875rem] font-medium text-[var(--muted)]">
            {sectionTitle}
          </p>
          <ol className="mt-0.5">
            {stagePoints.map((point) => (
              <PointRow
                key={point.id}
                point={point}
                projectKey={projectKey}
                groupId={group.id}
                canMutate={canMutate}
                showConfirm={stepId === 3}
              />
            ))}
          </ol>
        </section>
      ) : null}

      {group.preparedSubtypes && group.preparedSubtypes.length > 0 ? (
        <details className="text-sm text-[var(--muted)]">
          <summary className="cursor-pointer font-medium hover:text-[var(--foreground)]">
            Geplante Subtypen
          </summary>
          <ul className="mt-2 list-inside list-disc space-y-0.5">
            {group.preparedSubtypes.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
        </details>
      ) : null}

      <details className="text-sm text-[var(--muted)]">
        <summary className="cursor-pointer font-medium hover:text-[var(--foreground)]">
          Technische Details
        </summary>
        <dl className="mt-2 space-y-1 font-mono text-xs">
          <div className="flex flex-wrap gap-x-2">
            <dt>Report</dt>
            <dd className="break-all">{group.sapReport}</dd>
          </div>
          <div className="flex flex-wrap gap-x-2">
            <dt>Exporttyp</dt>
            <dd className="break-all">{group.exportType}</dd>
          </div>
          <div className="flex flex-wrap gap-x-2">
            <dt>RAW</dt>
            <dd className="break-all">{group.rawTargetPaths.join(", ")}</dd>
          </div>
          <div className="flex flex-wrap gap-x-2">
            <dt>Pipeline</dt>
            <dd>{group.pipeline}</dd>
          </div>
          <div className="flex flex-wrap gap-x-2">
            <dt>Erwartete Quellen</dt>
            <dd className="break-all">{group.expectedSourceFiles.join(", ")}</dd>
          </div>
        </dl>
      </details>

      {children}
    </div>
  );
}
