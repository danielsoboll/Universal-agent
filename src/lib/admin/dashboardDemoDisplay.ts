/**
 * TEMP investor demo — display-only overrides for Admin Dashboard.
 * No persistence, no pipeline logic. Remove when no longer needed.
 */
import type {
  SetupMainStepState,
  SetupOverview,
} from "@/lib/admin/setupMainSteps";

export type DashboardDemoKey = "kindesunterhalt" | "mario" | "dgl" | null;

export function matchDashboardDemoKey(name: string): DashboardDemoKey {
  const n = name.trim().toLowerCase();
  if (
    n.includes("kindesunterhalt") ||
    n.includes("kindsunterhalt") ||
    (n.includes("portal") && n.includes("kind"))
  ) {
    return "kindesunterhalt";
  }
  if (n.includes("mario")) return "mario";
  if (n.includes("dgl") || n.includes("z-analyse") || n.includes("z analyse")) {
    return "dgl";
  }
  return null;
}

/** Nicely ordered + labeled names for the project switcher. */
export function demoDisplayName(name: string): string {
  const key = matchDashboardDemoKey(name);
  if (key === "kindesunterhalt") return "Portal Kindesunterhalt";
  if (key === "mario") return "Website Mario";
  if (key === "dgl") return "DGL Z-Analyse";
  return name;
}

export function sortProjectsForDemoDisplay<T extends { name: string }>(
  projects: T[],
): T[] {
  const rank = (name: string) => {
    const key = matchDashboardDemoKey(name);
    if (key === "kindesunterhalt") return 0;
    if (key === "mario") return 1;
    if (key === "dgl") return 2;
    return 50;
  };
  return [...projects].sort((a, b) => {
    const d = rank(a.name) - rank(b.name);
    if (d !== 0) return d;
    return a.name.localeCompare(b.name, "de");
  });
}

/** List progress bar: fake for Portal/Mario; null = use real selected overview only. */
export function demoListPercent(name: string): number | null {
  const key = matchDashboardDemoKey(name);
  if (key === "kindesunterhalt") return 89;
  if (key === "mario") return 36;
  return null;
}

function patchStep(
  step: SetupMainStepState,
  patch: Partial<SetupMainStepState>,
): SetupMainStepState {
  return { ...step, ...patch };
}

/**
 * Overlay fake overall + step progress for investor walkthrough.
 * DGL and unknown projects: unchanged.
 */
export function applyDashboardDemoOverview(
  projectName: string,
  overview: SetupOverview,
): SetupOverview {
  const key = matchDashboardDemoKey(projectName);
  if (key === "dgl" || key == null) return overview;

  if (key === "kindesunterhalt") {
    return {
      ...overview,
      doneCount: 4,
      totalCount: 6,
      overallPercent: 89,
      overallSentence:
        "Initialisierung erledigt — steht bei Schritt 5 Feintuning (9 %)",
      nextStepId: 5,
      steps: overview.steps.map((step) => {
        if (step.id <= 4) {
          return patchStep(step, {
            status: "done",
            progressPercent: 100,
            locked: false,
            active: false,
            statusSentence: "Erledigt",
            subTasks: step.subTasks.map((t) => ({ ...t, status: "done" })),
          });
        }
        if (step.id === 5) {
          return patchStep(step, {
            status: "in_progress",
            progressPercent: 9,
            locked: false,
            active: true,
            statusSentence: "Feintuning läuft (9 %)",
            subTasks: step.subTasks.map((t, i) => ({
              ...t,
              status: i === 0 ? "in_progress" : "open",
            })),
          });
        }
        return patchStep(step, {
          status: "locked",
          progressPercent: 0,
          locked: true,
          active: false,
          statusSentence: "Gesperrt",
        });
      }),
    };
  }

  // mario → 36 % overall, standing at step 3 Datenbasis (~16 % of that step)
  return {
    ...overview,
    doneCount: 2,
    totalCount: 6,
    overallPercent: 36,
    overallSentence:
      "Initialisierung erledigt — steht bei Schritt 3 Datenbasis (16 %)",
    nextStepId: 3,
    steps: overview.steps.map((step) => {
      if (step.id <= 2) {
        return patchStep(step, {
          status: "done",
          progressPercent: 100,
          locked: false,
          active: false,
          statusSentence: "Erledigt",
          subTasks: step.subTasks.map((t) => ({ ...t, status: "done" })),
        });
      }
      if (step.id === 3) {
        return patchStep(step, {
          status: "in_progress",
          progressPercent: 16,
          locked: false,
          active: true,
          statusSentence: "Datenbasis in Arbeit (16 %)",
          subTasks: step.subTasks.map((t, i) => ({
            ...t,
            status: i === 0 ? "in_progress" : "open",
          })),
        });
      }
      return patchStep(step, {
        status: "locked",
        progressPercent: 0,
        locked: true,
        active: false,
        statusSentence: "Gesperrt",
      });
    }),
  };
}
