"use client";

import type {
  FahrplanOverallStatus,
  FahrplanStepId,
  FahrplanStepStatus,
} from "@/lib/rebuild/controlTablesFahrplanTypes";
import { FAHRPLAN_STEP_IDS } from "@/lib/rebuild/controlTablesFahrplanTypes";
import {
  CT_STEP_SHORT_LABEL,
  ctStepTone,
} from "@/components/admin/fahrplan/controlTablesFahrplanUi";

function currentStepId(
  steps: Record<FahrplanStepId, { status: FahrplanStepStatus }>,
): FahrplanStepId | null {
  for (const id of FAHRPLAN_STEP_IDS) {
    const s = steps[id].status;
    if (s === "ready" || s === "running" || s === "failed") return id;
  }
  if (FAHRPLAN_STEP_IDS.every((id) => steps[id].status === "success")) {
    return null;
  }
  return null;
}

export function ControlTablesProgressBar({
  steps,
}: {
  steps: Record<FahrplanStepId, { status: FahrplanStepStatus }>;
  /** Kept for call-site compatibility; overall chip removed (no status duplication). */
  overall?: FahrplanOverallStatus;
}) {
  const successCount = FAHRPLAN_STEP_IDS.filter(
    (id) => steps[id].status === "success",
  ).length;
  const activeId = currentStepId(steps);

  return (
    <section className="space-y-2" aria-label="Fortschritt">
      <p className="text-[0.875rem] text-[var(--muted)]">
        {successCount}/{FAHRPLAN_STEP_IDS.length} erledigt
      </p>

      <ol className="flex items-start justify-between gap-0.5">
        {FAHRPLAN_STEP_IDS.map((id, index) => {
          const status = steps[id].status;
          const tone = ctStepTone(status);
          const isCurrent = activeId === id;
          const isLast = index === FAHRPLAN_STEP_IDS.length - 1;

          return (
            <li
              key={id}
              className="relative flex min-w-0 flex-1 flex-col items-center"
            >
              {!isLast ? (
                <span
                  className={`absolute left-[calc(50%+0.6rem)] right-[calc(-50%+0.6rem)] top-[0.65rem] h-px ${
                    status === "success"
                      ? "bg-[var(--success)]/60"
                      : "progress-track"
                  }`}
                  aria-hidden
                />
              ) : null}
              <span
                className={`relative z-[1] flex h-5 w-5 items-center justify-center rounded-full text-[0.6875rem] font-medium sm:h-6 sm:w-6 sm:text-xs ${
                  status === "success"
                    ? "bg-emerald-500/20 text-emerald-700 dark:text-emerald-300"
                    : isCurrent
                      ? "bg-yellow-400/25 text-yellow-800 ring-1 ring-yellow-500/50 dark:text-yellow-100"
                      : status === "failed"
                        ? "bg-[var(--danger-soft)] text-[var(--danger)]"
                        : "bg-[var(--surface-raised)] text-[var(--muted)] ring-1 ring-[var(--border)]"
                }`}
                title={`${CT_STEP_SHORT_LABEL[id]}`}
                aria-current={isCurrent ? "step" : undefined}
              >
                {status === "success" ? (
                  <span aria-hidden>✓</span>
                ) : status === "running" ? (
                  <span
                    className="h-3 w-3 animate-spin rounded-full border border-yellow-500/40 border-t-yellow-700 dark:border-t-yellow-200"
                    aria-hidden
                  />
                ) : (
                  <span
                    className={`h-2 w-2 rounded-full ${
                      isCurrent
                        ? "bg-yellow-500 dark:bg-yellow-300"
                        : status === "failed"
                          ? "bg-[var(--danger)]"
                          : "bg-slate-400 dark:bg-slate-500"
                    }`}
                    aria-hidden
                  />
                )}
              </span>
              <span
                className={`mt-1 max-w-full px-0.5 text-center text-[0.75rem] leading-tight sm:text-sm ${
                  isCurrent
                    ? `font-medium ${tone.text}`
                    : status === "success"
                      ? tone.text
                      : "text-[var(--muted)]"
                }`}
              >
                {CT_STEP_SHORT_LABEL[id]}
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
