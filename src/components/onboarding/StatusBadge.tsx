import {
  STEP_DISPLAY_BADGE_CLASS,
  STEP_DISPLAY_LABELS,
  getStepDisplayStatus,
  type FahrplanStepLike,
  type StepDisplayStatus,
} from "@/lib/onboarding/stepDisplay";

export function StatusBadge({
  status,
  displayStatus,
  className = "",
}: {
  /** Persisted workflow status (fallback). */
  status: string;
  /** Optional UI-mapped status — preferred when provided. */
  displayStatus?: StepDisplayStatus;
  className?: string;
}) {
  const resolved: StepDisplayStatus =
    displayStatus ??
    getStepDisplayStatus({ status } satisfies FahrplanStepLike);

  return (
    <span
      className={`inline-flex max-w-full shrink-0 items-center rounded-md px-1.5 py-0.5 text-sm font-semibold leading-tight ${STEP_DISPLAY_BADGE_CLASS[resolved]} ${className}`}
    >
      {STEP_DISPLAY_LABELS[resolved]}
    </span>
  );
}
