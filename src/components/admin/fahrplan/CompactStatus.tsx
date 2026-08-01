"use client";

import type { FahrplanStepStatus } from "@/lib/rebuild/controlTablesFahrplanTypes";
import { FAHRPLAN_STEP_STATUS_LABELS_DE } from "@/lib/rebuild/controlTablesFahrplanTypes";

/** Solid colored button surfaces per step status (presentation only). */
export function statusButtonClass(status: FahrplanStepStatus): string {
  switch (status) {
    case "ready":
      return "border-[color-mix(in_srgb,var(--warning)_55%,transparent)] bg-[var(--warning-soft)] text-[var(--warning)] hover:brightness-95 dark:border-yellow-400/50 dark:bg-yellow-400 dark:text-yellow-950 dark:hover:bg-yellow-300";
    case "running":
      return "border-[color-mix(in_srgb,var(--warning)_55%,transparent)] bg-[var(--warning-soft)] text-[var(--warning)] dark:border-yellow-400/50 dark:bg-yellow-400 dark:text-yellow-950";
    case "success":
      return "border-[color-mix(in_srgb,var(--success)_45%,transparent)] bg-[var(--success)] text-white hover:brightness-110 dark:border-emerald-400/40 dark:bg-emerald-500 dark:text-emerald-950 dark:hover:bg-emerald-400";
    case "failed":
      return "border-[color-mix(in_srgb,var(--danger)_55%,transparent)] bg-[var(--danger)] text-white hover:brightness-110";
    case "not_available":
    default:
      return "border-[var(--border)] bg-[var(--disabled-soft)] text-[var(--disabled)]";
  }
}

const BTN_BASE =
  "btn-status-action inline-flex min-h-11 items-center justify-center gap-1 rounded-lg border px-2.5 py-1.5 text-[0.9375rem] font-medium leading-none disabled:cursor-not-allowed disabled:opacity-90 sm:min-h-12 sm:px-3 sm:py-2 sm:text-[1.0625rem]";

function RunningSpinner({ className = "" }: { className?: string }) {
  return (
    <span
      className={`h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-[color-mix(in_srgb,var(--warning)_25%,transparent)] border-t-[var(--warning)] dark:border-yellow-950/25 dark:border-t-yellow-950 ${className}`}
      aria-hidden
    />
  );
}

/**
 * Colored status/action button for Control-Tables Fahrplan.
 * Presentation only — callers control disabled / onClick (lock logic unchanged).
 */
export function StatusActionButton({
  status,
  label,
  disabled,
  onClick,
  className = "",
  type = "button",
}: {
  status: FahrplanStepStatus;
  label: string;
  disabled?: boolean;
  onClick?: () => void;
  className?: string;
  type?: "button" | "submit";
}) {
  const isRunning = status === "running";
  return (
    <button
      type={type}
      className={`${BTN_BASE} ${statusButtonClass(status)} ${className}`}
      disabled={disabled || isRunning}
      onClick={onClick}
      aria-busy={isRunning || undefined}
    >
      {isRunning ? <RunningSpinner /> : null}
      <span>{label}</span>
    </button>
  );
}

/** Non-interactive colored status chip (same look as buttons). */
export function StatusStatusButton({
  status,
  label,
  className = "",
}: {
  status: FahrplanStepStatus;
  label?: string;
  className?: string;
}) {
  const text = label ?? FAHRPLAN_STEP_STATUS_LABELS_DE[status];
  return (
    <span
      className={`${BTN_BASE} ${statusButtonClass(status)} pointer-events-none select-none ${className}`}
      role="status"
    >
      {status === "running" ? <RunningSpinner /> : null}
      <span>{text}</span>
    </span>
  );
}

/** @deprecated Prefer StatusStatusButton / StatusActionButton */
export function CompactStatus({
  status,
  className = "",
}: {
  status: FahrplanStepStatus;
  className?: string;
}) {
  return <StatusStatusButton status={status} className={className} />;
}

/** Minimal list marker kept for callers that still need a tiny glyph. */
export function StepListMarker({
  status,
}: {
  status: FahrplanStepStatus;
}) {
  if (status === "success") {
    return (
      <span
        className="w-5 shrink-0 text-center text-base font-medium text-[var(--success)]"
        aria-hidden
      >
        ✓
      </span>
    );
  }
  if (status === "failed") {
    return (
      <span
        className="w-5 shrink-0 text-center text-base font-medium text-[var(--danger)]"
        aria-hidden
      >
        ✕
      </span>
    );
  }
  if (status === "running") {
    return (
      <span
        className="mt-0.5 h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-yellow-500/30 border-t-yellow-600 dark:border-t-yellow-300"
        aria-hidden
      />
    );
  }
  return (
    <span
      className="w-5 shrink-0 text-center text-base text-[var(--muted)]"
      aria-hidden
    >
      ○
    </span>
  );
}
