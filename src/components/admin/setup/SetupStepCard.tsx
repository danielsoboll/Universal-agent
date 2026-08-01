import type { SetupMainStepState } from "@/lib/admin/setupMainSteps";
import {
  mainStatusToFahrplanTone,
  setupStepStatusLabel,
} from "@/lib/admin/setupMainSteps";
import { StatusStatusButton } from "@/components/admin/fahrplan/CompactStatus";
import { PressNavigateLink } from "@/components/ui/PressNavigateLink";

/** Compact dark/neutral step row for the project dashboard. */
export function SetupStepCard({ step }: { step: SetupMainStepState }) {
  const tone = mainStatusToFahrplanTone(step.status);
  const statusLabel =
    step.progressPercent >= 100
      ? "Erledigt"
      : setupStepStatusLabel(step.status);

  const body = (
    <div
      className={[
        "admin-card main-step-card flex items-start gap-2 rounded-[12px] border p-2.5",
        step.locked ? "main-step-card--locked" : "",
        step.status === "done" ? "main-step-card--done" : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <span
        className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-[var(--border)] bg-[var(--surface)] text-[0.8125rem] font-semibold tabular-nums text-[var(--muted)]"
        aria-hidden
      >
        {step.id}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-2">
          <h3 className="text-[1.0625rem] font-medium leading-snug tracking-tight break-words">
            {step.title}
          </h3>
          <StatusStatusButton
            status={tone}
            label={statusLabel}
            className="shrink-0 !min-h-0 !px-2 !py-0.5 !text-[0.75rem] !font-medium"
          />
        </div>
        <div className="mt-1.5">
          <div
            className="progress-track h-1.5 overflow-hidden rounded-full"
            role="progressbar"
            aria-valuenow={step.progressPercent}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={`Fortschritt ${step.title}`}
          >
            <div
              className={`h-full rounded-full transition-[width] ${
                step.status === "error"
                  ? "progress-fill-error"
                  : step.status === "done"
                    ? "progress-fill-done"
                    : step.locked
                      ? "progress-fill-locked"
                      : "progress-fill"
              }`}
              style={{ width: `${step.progressPercent}%` }}
            />
          </div>
          <div className="mt-1 flex items-baseline justify-between gap-2 text-[0.75rem] text-[var(--muted)]">
            <span className="min-w-0 break-words leading-snug">
              {step.locked ? "Gesperrt" : step.statusSentence}
            </span>
            <span className="shrink-0 tabular-nums font-medium">
              {step.progressPercent}&nbsp;%
            </span>
          </div>
        </div>
      </div>
    </div>
  );

  if (step.locked) {
    return (
      <div aria-disabled="true" title="Vorherigen Schritt zuerst abschließen">
        {body}
      </div>
    );
  }

  return (
    <PressNavigateLink
      href={step.href}
      className="block focus-visible:outline-none"
    >
      {body}
    </PressNavigateLink>
  );
}
