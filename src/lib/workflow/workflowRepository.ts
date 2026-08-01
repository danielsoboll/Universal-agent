import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import { appConfigPath } from "@/lib/localAuth/crypto";
import type { LocalProject } from "@/lib/localAuth/types";
import { resolveActiveWorkflowProcess } from "@/lib/workflow/resolveActiveProcess";
import type {
  WorkflowProcessDefinition,
  WorkflowRuntimeState,
  WorkflowStepState,
  WorkflowStepStatus,
} from "@/lib/workflow/types";

function workflowDir() {
  const dir = appConfigPath("workflows");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function filePath(projectId: string) {
  return path.join(workflowDir(), `${projectId}.json`);
}

function projectsFilePath() {
  return appConfigPath("projects.json");
}

function readProjectSync(projectId: string): LocalProject | null {
  const p = projectsFilePath();
  if (!existsSync(p)) return null;
  try {
    const rows = JSON.parse(readFileSync(p, "utf8")) as LocalProject[];
    return Array.isArray(rows)
      ? (rows.find((r) => r.id === projectId) ?? null)
      : null;
  } catch {
    return null;
  }
}

function emptyStepState(
  status: WorkflowStepStatus = "nicht_begonnen",
): WorkflowStepState {
  return {
    status,
    completed_at: null,
    notes: "",
    manual_confirmed: false,
    last_check: null,
    last_run_log: null,
  };
}

function processForProject(projectId: string): WorkflowProcessDefinition {
  const project = readProjectSync(projectId);
  return resolveActiveWorkflowProcess(
    project ?? { domain_profile_id: undefined, enabled_adapter_ids: [] },
  );
}

export function defaultWorkflowState(
  projectId: string,
  process?: WorkflowProcessDefinition,
): WorkflowRuntimeState {
  const def = process ?? processForProject(projectId);
  const steps: Record<string, WorkflowStepState> = {};
  for (const step of def.steps) {
    steps[step.id] = emptyStepState();
  }
  return {
    process_id: def.id,
    project_id: projectId,
    updated_at: new Date().toISOString(),
    steps,
  };
}

function normalize(
  state: WorkflowRuntimeState,
  process: WorkflowProcessDefinition,
): WorkflowRuntimeState {
  const base = defaultWorkflowState(state.project_id, process);
  for (const id of Object.keys(base.steps)) {
    if (state.steps[id]) {
      base.steps[id] = {
        ...emptyStepState(),
        ...state.steps[id],
      };
    }
  }
  base.process_id = process.id;
  base.updated_at = state.updated_at || new Date().toISOString();
  return base;
}

export function loadWorkflowState(projectId: string): WorkflowRuntimeState {
  const process = processForProject(projectId);
  const p = filePath(projectId);
  if (!existsSync(p)) return defaultWorkflowState(projectId, process);
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as WorkflowRuntimeState;
    return normalize(raw, process);
  } catch {
    return defaultWorkflowState(projectId, process);
  }
}

export function saveWorkflowState(state: WorkflowRuntimeState): void {
  const next = {
    ...state,
    updated_at: new Date().toISOString(),
  };
  writeFileSync(
    filePath(state.project_id),
    `${JSON.stringify(next, null, 2)}\n`,
    "utf8",
  );
}

export function updateStepState(
  projectId: string,
  stepId: string,
  patch: Partial<WorkflowStepState>,
): WorkflowRuntimeState {
  const state = loadWorkflowState(projectId);
  const prev = state.steps[stepId] ?? emptyStepState();
  state.steps[stepId] = { ...prev, ...patch };
  saveWorkflowState(state);
  return state;
}
