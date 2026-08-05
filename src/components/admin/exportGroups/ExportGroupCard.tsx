import type { ExportGroupState } from "@/lib/admin/exportGroups/types";
import type { PointStatus } from "@/lib/admin/exportGroups/types";
import { StatusStatusButton } from "@/components/admin/fahrplan/CompactStatus";
import { PressNavigateLink } from "@/components/ui/PressNavigateLink";
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

/** Compact clickable export-group row (Areas 3–5). */
export function ExportGroupCard({
  group,
  href,
  mode,
}: {
  group: ExportGroupState;
  href: string;
  mode: "export" | "validation" | "feintuning";
}) {
  const percent =
    mode === "export"
      ? group.progressPercent
      : mode === "validation"
        ? group.validation.progressPercent
        : group.feintuning.progressPercent;
  const locked =
    mode === "validation"
      ? group.validation.locked
      : mode === "feintuning"
        ? group.feintuning.locked
        : false;
  const status: PointStatus = locked
    ? "locked"
    : percent >= 100
      ? "done"
      : group.technicalStatus === "error"
        ? "error"
        : percent > 0
          ? "in_progress"
          : "open";
  const tone = pointToTone(status);

  const body = (
    <div
      className={[
        "admin-card flex items-start gap-2 rounded-[12px] border p-2.5",
        locked ? "main-step-card--locked" : "",
        status === "done" ? "main-step-card--done" : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-2">
          <h3 className="text-[1.0625rem] font-medium leading-snug tracking-tight break-words">
            {group.title}
          </h3>
          <StatusStatusButton
            status={tone}
            label={pointLabel(status)}
            className="shrink-0 !min-h-0 !px-2 !py-0.5 !text-[0.75rem] !font-medium"
          />
        </div>
        <p className="mt-0.5 text-[0.875rem] leading-snug text-[var(--muted)] break-words">
          {group.exportType}
          {group.sapReport && group.sapReport !== "—"
            ? ` · ${group.sapReport}`
            : ""}
        </p>
        <div className="mt-1.5">
          <div
            className="progress-track h-1.5 overflow-hidden rounded-full"
            role="progressbar"
            aria-valuenow={percent}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div
              className={`h-full rounded-full ${
                status === "error"
                  ? "progress-fill-error"
                  : status === "done"
                    ? "progress-fill-done"
                    : locked
                      ? "progress-fill-locked"
                      : "progress-fill"
              }`}
              style={{ width: `${percent}%` }}
            />
          </div>
          <div className="mt-1 flex items-baseline justify-between gap-2 text-[0.75rem] text-[var(--muted)]">
            <span className="min-w-0 break-words leading-snug">
              {locked ? "Gesperrt" : group.nextAction}
            </span>
            <span className="shrink-0 tabular-nums font-medium">
              {percent}&nbsp;%
            </span>
          </div>
        </div>
      </div>
    </div>
  );

  return (
    <PressNavigateLink href={href} className="block focus-visible:outline-none">
      {body}
    </PressNavigateLink>
  );
}
