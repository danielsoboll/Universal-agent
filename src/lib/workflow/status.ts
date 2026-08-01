import type { ResolvedWorkflowStep } from "@/lib/workflow/resolve";
import type {
  WorkflowRuntimeState,
  WorkflowStepState,
  WorkflowStepStatus,
} from "@/lib/workflow/types";

function isDone(s: WorkflowStepState | undefined): boolean {
  if (!s) return false;
  return (
    s.status === "abgeschlossen" ||
    s.status === "uebersprungen" ||
    s.manual_confirmed
  );
}

export function deriveStepStatus(
  step: ResolvedWorkflowStep,
  state: WorkflowStepState | undefined,
  all: ResolvedWorkflowStep[],
  runtime: WorkflowRuntimeState,
): WorkflowStepStatus {
  if (state?.status === "uebersprungen") return "uebersprungen";
  if (state?.manual_confirmed || state?.status === "abgeschlossen") {
    return "abgeschlossen";
  }
  if (state?.status === "fehler") return "fehler";
  if (state?.status === "pruefung_laeuft") return "pruefung_laeuft";
  if (state?.status === "in_arbeit") return "in_arbeit";

  const depsOk = step.depends_on.every((id) => isDone(runtime.steps[id]));
  if (!depsOk) {
    if (state?.status === "nicht_begonnen" || !state) return "blockiert";
    return "blockiert";
  }

  if (state?.status === "wartet_auf_datei") return "wartet_auf_datei";

  if (
    (step.step_type === "file_delivery" || step.step_type === "validation") &&
    state?.last_check &&
    !state.last_check.ok
  ) {
    return "wartet_auf_datei";
  }

  void all;
  return "bereit";
}

export type DashboardSummary = {
  total: number;
  completed: number;
  blocked: number;
  errored: number;
  nextStepId: string | null;
  progressPercent: number;
  lastCheckAt: string | null;
};

export function buildDashboardSummary(
  steps: ResolvedWorkflowStep[],
  runtime: WorkflowRuntimeState,
): DashboardSummary {
  let completed = 0;
  let blocked = 0;
  let errored = 0;
  let nextStepId: string | null = null;
  let lastCheckAt: string | null = null;

  for (const step of steps) {
    const st = runtime.steps[step.id];
    const status = deriveStepStatus(step, st, steps, runtime);
    if (status === "abgeschlossen" || status === "uebersprungen") completed += 1;
    if (status === "blockiert") blocked += 1;
    if (status === "fehler") errored += 1;
    if (
      !nextStepId &&
      status !== "abgeschlossen" &&
      status !== "uebersprungen" &&
      status !== "blockiert"
    ) {
      nextStepId = step.id;
    }
    if (st?.last_check?.at) {
      if (!lastCheckAt || st.last_check.at > lastCheckAt) {
        lastCheckAt = st.last_check.at;
      }
    }
  }

  if (!nextStepId) {
    const blockedFirst = steps.find((s) => {
      const status = deriveStepStatus(s, runtime.steps[s.id], steps, runtime);
      return status === "blockiert" || status === "fehler";
    });
    nextStepId = blockedFirst?.id ?? null;
  }

  const total = steps.length;
  return {
    total,
    completed,
    blocked,
    errored,
    nextStepId,
    progressPercent: total ? Math.round((completed / total) * 100) : 0,
    lastCheckAt,
  };
}
