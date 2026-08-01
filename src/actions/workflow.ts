"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireLocalAdmin } from "@/lib/localAuth/session";
import { fileProjectRepository } from "@/lib/localAuth/projectRepository";
import { fileUserRepository } from "@/lib/localAuth/userRepository";
import { resolveActiveWorkflowProcess } from "@/lib/workflow/resolveActiveProcess";
import { resolveWorkflowStep } from "@/lib/workflow/resolve";
import { openLocalPath, runWorkflowCli, writeUploadedFiles } from "@/lib/workflow/run";
import {
  buildDashboardSummary,
  deriveStepStatus,
} from "@/lib/workflow/status";
import { validateWorkflowStep, resolveCheckPathForOpen } from "@/lib/workflow/validate";
import {
  loadWorkflowState,
  updateStepState,
} from "@/lib/workflow/workflowRepository";
import { mergeProcessConfig } from "@/lib/workflow/placeholders";
import type { ProjectProcessConfig } from "@/lib/workflow/types";

function revalidateAdmin() {
  revalidatePath("/admin");
  revalidatePath("/admin/project");
}

async function getProjectOrThrow(projectId: string) {
  const project = await fileProjectRepository.getById(projectId);
  if (!project) throw new Error("Projekt nicht gefunden.");
  return project;
}

function findStepDef(
  project: Awaited<ReturnType<typeof getProjectOrThrow>>,
  stepId: string,
) {
  const process = resolveActiveWorkflowProcess(project);
  const def = process.steps.find((s) => s.id === stepId);
  if (!def) throw new Error(`Unbekannter Schritt: ${stepId}`);
  return def;
}

export async function validateWorkflowStepAction(formData: FormData) {
  await requireLocalAdmin();
  const projectId = String(formData.get("project_id") ?? "").trim();
  const stepId = String(formData.get("step_id") ?? "").trim();
  const project = await getProjectOrThrow(projectId);
  const resolved = resolveWorkflowStep(findStepDef(project, stepId), project);

  updateStepState(projectId, stepId, { status: "pruefung_laeuft" });
  const check = validateWorkflowStep(project, resolved);

  updateStepState(projectId, stepId, {
    status: check.ok ? "abgeschlossen" : "fehler",
    completed_at: check.ok ? new Date().toISOString() : null,
    manual_confirmed: check.ok,
    last_check: check,
  });

  revalidateAdmin();
  redirect(
    `/admin?step=${encodeURIComponent(stepId)}&flash=${encodeURIComponent(
      check.ok ? "Prüfung OK" : "Prüfung fehlgeschlagen",
    )}`,
  );
}

export async function markWorkflowStepDoneAction(_formData: FormData) {
  await requireLocalAdmin();
  // Manuelles „Als erledigt markieren“ ist deaktiviert.
  // Status kommt nur aus technischen Validierungen / Pipeline-Läufen.
  revalidateAdmin();
  redirect(
    `/admin/steps/4?flash=${encodeURIComponent(
      "Manuelles Abschließen deaktiviert — bitte technischen Fahrplan nutzen.",
    )}`,
  );
}

export async function grantWorkflowApprovalAction(formData: FormData) {
  await requireLocalAdmin();
  const projectId = String(formData.get("project_id") ?? "").trim();
  const stepId = String(formData.get("step_id") ?? "").trim();

  const users = await fileUserRepository.list();
  const activeUser = users.find((u) => u.role === "user" && u.enabled);
  if (!activeUser) {
    updateStepState(projectId, stepId, {
      status: "fehler",
      last_check: {
        at: new Date().toISOString(),
        ok: false,
        messages: [
          "Kein aktiver User gefunden. Bitte unter /admin/users anlegen.",
        ],
      },
    });
    revalidateAdmin();
    redirect(
      `/admin?step=${encodeURIComponent(stepId)}&flash=${encodeURIComponent(
        "Freigabe blockiert – kein aktiver User",
      )}`,
    );
  }

  updateStepState(projectId, stepId, {
    status: "abgeschlossen",
    completed_at: new Date().toISOString(),
    manual_confirmed: true,
    last_check: {
      at: new Date().toISOString(),
      ok: true,
      messages: [`Freigabe erteilt. Aktiver User: ${activeUser.email}`],
    },
  });

  revalidateAdmin();
  redirect(
    `/admin?step=${encodeURIComponent(stepId)}&flash=${encodeURIComponent(
      "Freigabe erteilt",
    )}`,
  );
}

export async function runWorkflowPipelineAction(formData: FormData) {
  await requireLocalAdmin();
  const projectId = String(formData.get("project_id") ?? "").trim();
  const stepId = String(formData.get("step_id") ?? "").trim();
  const project = await getProjectOrThrow(projectId);
  const resolved = resolveWorkflowStep(findStepDef(project, stepId), project);

  updateStepState(projectId, stepId, { status: "in_arbeit" });
  const run = runWorkflowCli(project, resolved);
  const check = validateWorkflowStep(project, resolved);

  // Erfolg nur mit CLI-OK und erfüllten Artefakt-Kriterien (Verify: CLI oder Dateien).
  const success =
    resolved.id === "qa.verify_knowledge"
      ? run.ok || check.ok
      : run.ok && check.ok;

  updateStepState(projectId, stepId, {
    status: success ? "abgeschlossen" : "fehler",
    completed_at: success ? new Date().toISOString() : null,
    manual_confirmed: success,
    last_check: {
      at: new Date().toISOString(),
      ok: success,
      messages: [
        `Befehl: ${run.command}`,
        `Exit: ${run.exit_code ?? "—"}`,
        ...(run.ok ? [] : [run.stderr || "CLI fehlgeschlagen"]),
        ...check.messages,
      ],
      matched_files: check.matched_files,
    },
    last_run_log: [run.stdout, run.stderr].filter(Boolean).join("\n---\n").slice(-8000),
  });

  revalidateAdmin();
  redirect(
    `/admin?step=${encodeURIComponent(stepId)}&flash=${encodeURIComponent(
      success ? "Verarbeitung OK" : "Verarbeitung fehlgeschlagen",
    )}`,
  );
}

export async function openWorkflowFolderAction(formData: FormData) {
  await requireLocalAdmin();
  const projectId = String(formData.get("project_id") ?? "").trim();
  const stepId = String(formData.get("step_id") ?? "").trim();
  const project = await getProjectOrThrow(projectId);
  const resolved = resolveWorkflowStep(findStepDef(project, stepId), project);
  const target = resolveCheckPathForOpen(project, resolved);
  const result = openLocalPath(target);

  updateStepState(projectId, stepId, {
    last_check: {
      at: new Date().toISOString(),
      ok: result.ok,
      messages: result.ok
        ? [`Ordner geöffnet: ${target}`]
        : [result.stderr || `Konnte nicht öffnen: ${target}`],
    },
  });

  revalidateAdmin();
  redirect(
    `/admin?step=${encodeURIComponent(stepId)}&flash=${encodeURIComponent(
      result.ok ? "Ordner geöffnet" : "Ordner öffnen fehlgeschlagen",
    )}`,
  );
}

export async function uploadWorkflowFilesAction(formData: FormData) {
  await requireLocalAdmin();
  const projectId = String(formData.get("project_id") ?? "").trim();
  const stepId = String(formData.get("step_id") ?? "").trim();
  const project = await getProjectOrThrow(projectId);
  const resolved = resolveWorkflowStep(findStepDef(project, stepId), project);

  const files = formData.getAll("files").filter((f): f is File => f instanceof File);
  const buffers: Array<{ name: string; bytes: Buffer }> = [];
  for (const f of files) {
    if (!f.size) continue;
    buffers.push({ name: f.name, bytes: Buffer.from(await f.arrayBuffer()) });
  }

  let destination = resolved.destination_path;
  // For table place step, default to definitions; allow override
  const destOverride = String(formData.get("destination_subdir") ?? "").trim();
  if (destOverride === "definitions") {
    destination = resolved.parameters.find((p) => p.key === "Definitionen")?.value ?? destination;
  } else if (destOverride === "contents") {
    destination = resolved.parameters.find((p) => p.key === "Inhalte")?.value ?? destination;
  }

  const written = writeUploadedFiles(project, destination, buffers);
  const check = validateWorkflowStep(project, resolved);

  updateStepState(projectId, stepId, {
    status: written.ok && check.ok ? "abgeschlossen" : written.ok ? "wartet_auf_datei" : "fehler",
    completed_at: written.ok && check.ok ? new Date().toISOString() : null,
    manual_confirmed: written.ok && check.ok,
    last_check: {
      at: new Date().toISOString(),
      ok: written.ok && check.ok,
      messages: [...written.messages, ...check.messages],
      matched_files: check.matched_files,
    },
  });

  revalidateAdmin();
  redirect(
    `/admin?step=${encodeURIComponent(stepId)}&flash=${encodeURIComponent(
      written.ok ? "Dateien gespeichert" : "Upload fehlgeschlagen",
    )}`,
  );
}

export async function saveStepNotesAction(formData: FormData) {
  await requireLocalAdmin();
  const projectId = String(formData.get("project_id") ?? "").trim();
  const stepId = String(formData.get("step_id") ?? "").trim();
  const notes = String(formData.get("notes") ?? "").trim();
  updateStepState(projectId, stepId, { notes });
  revalidateAdmin();
  redirect(`/admin?step=${encodeURIComponent(stepId)}`);
}

export async function getWorkflowViewModel(projectId: string) {
  const project = await getProjectOrThrow(projectId);
  const process = resolveActiveWorkflowProcess(project);
  const runtime = loadWorkflowState(projectId);
  const steps = process.steps
    .slice()
    .sort((a, b) => a.sequence - b.sequence)
    .map((s) => {
      const resolved = resolveWorkflowStep(s, project);
      const st = runtime.steps[s.id];
      const status = deriveStepStatus(resolved, st, [], runtime);
      return { resolved, state: st, status };
    });

  // Fix derive with full list
  const resolvedList = steps.map((s) => s.resolved);
  const withStatus = steps.map((s) => ({
    ...s,
    status: deriveStepStatus(s.resolved, s.state, resolvedList, runtime),
  }));

  const summary = buildDashboardSummary(resolvedList, runtime);
  return {
    process,
    project,
    processConfig: mergeProcessConfig(project.process_config),
    steps: withStatus,
    summary,
    runtime,
  };
}

export type { ProjectProcessConfig };
