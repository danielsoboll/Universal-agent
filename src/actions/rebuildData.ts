"use server";

import { revalidatePath } from "next/cache";
import { spawn } from "child_process";
import { existsSync, readFileSync } from "fs";
import path from "path";
import {
  PROJECT_ADMIN_REQUIRED_HINT,
  requireProjectConsoleAccess,
  requireProjectMutationAccess,
} from "@/lib/onboarding/access";
import { getLocalDataRoot } from "@/lib/localData/root";
import { resolveWritablePath } from "@/lib/localData/paths";
import { inspectRawSourcesForType } from "@/lib/rebuild/validateRawSources";
import {
  REBUILD_STATUS_LABELS_DE,
  type RebuildStatusStep,
} from "@/lib/rebuild/types";

export type RebuildUiStatus = {
  project: string;
  step: RebuildStatusStep | "idle" | "running" | "error";
  step_label_de: string;
  detail: string | null;
  steps_completed: string[];
  source_files: Array<{ relativePath: string; bytes: number }>;
  source_ok: boolean;
  source_message: string;
  last_report: {
    lines_read?: number;
    error_count?: number;
    canonical_records?: number;
    search_documents?: number;
    embeddings?: number;
    index_entries?: number;
    smoke_ok?: boolean;
    derived_replaced?: boolean;
    old_deleted?: boolean;
    success?: boolean;
    structural_validation_ok?: boolean;
    at?: string;
  } | null;
  error: string | null;
};

function readJsonIfExists<T>(abs: string): T | null {
  if (!existsSync(abs)) return null;
  try {
    return JSON.parse(readFileSync(abs, "utf8")) as T;
  } catch {
    return null;
  }
}

export async function getControlTablesRebuildStatus(
  projectKey = "P01",
): Promise<RebuildUiStatus> {
  await requireProjectConsoleAccess();
  getLocalDataRoot();

  const inspect = inspectRawSourcesForType({
    projectKey,
    type: "control-tables",
  });

  const statusPath = resolveWritablePath(
    projectKey,
    "logs",
    "rebuild-control-tables-status.json",
  );
  const reportPath = resolveWritablePath(
    projectKey,
    "logs",
    "rebuild-control-tables-report.json",
  );

  const status = readJsonIfExists<{
    step?: string;
    step_label_de?: string;
    detail?: string | null;
    steps_completed?: string[];
    error?: string;
  }>(statusPath);
  const report = readJsonIfExists<{
    lines_read?: number;
    error_count?: number;
    canonical_records?: number;
    search_documents?: number;
    embeddings?: number;
    index_entries?: number;
    smoke_ok?: boolean;
    derived_replaced?: boolean;
    old_deleted?: boolean;
    success?: boolean;
    structural_validation_ok?: boolean;
    at?: string;
  }>(reportPath);

  const step = (status?.step as RebuildStatusStep | undefined) ?? "idle";
  const label =
    step in REBUILD_STATUS_LABELS_DE
      ? REBUILD_STATUS_LABELS_DE[step as RebuildStatusStep]
      : status?.step_label_de || "Bereit";

  return {
    project: projectKey,
    step: status ? step : "idle",
    step_label_de: label,
    detail: status?.detail ?? null,
    steps_completed: status?.steps_completed ?? [],
    source_files: inspect.sources.map((s) => ({
      relativePath: s.relativePath,
      bytes: s.bytes,
    })),
    source_ok: inspect.ok,
    source_message: inspect.message,
    last_report: report,
    error: status?.error ?? null,
  };
}

export async function startControlTablesRebuildAction(
  projectKey = "P01",
): Promise<{ ok: boolean; message: string }> {
  try {
    await requireProjectMutationAccess();
  } catch (e) {
    return {
      ok: false,
      message:
        e instanceof Error ? e.message : PROJECT_ADMIN_REQUIRED_HINT,
    };
  }
  getLocalDataRoot();

  const inspect = inspectRawSourcesForType({
    projectKey,
    type: "control-tables",
  });
  if (!inspect.ok) {
    return { ok: false, message: inspect.message };
  }

  const statusPath = resolveWritablePath(
    projectKey,
    "logs",
    "rebuild-control-tables-status.json",
  );
  // Mark running immediately for UI polling
  const { writeFileSync, mkdirSync } = await import("fs");
  mkdirSync(path.dirname(statusPath), { recursive: true });
  writeFileSync(
    statusPath,
    `${JSON.stringify(
      {
        at: new Date().toISOString(),
        project: projectKey,
        type: "control-tables",
        step: "running",
        step_label_de: "Läuft…",
        detail: "Rebuild gestartet",
        steps_completed: [],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const child = spawn(
    "npm",
    [
      "run",
      "rebuild-data",
      "--",
      "--project",
      projectKey,
      "--type",
      "control-tables",
    ],
    {
      cwd: process.cwd(),
      env: process.env,
      detached: true,
      stdio: "ignore",
    },
  );
  child.unref();

  revalidatePath("/admin/extraction");
  revalidatePath("/admin/dashboard");
  revalidatePath("/admin/steps", "layout");
  return {
    ok: true,
    message: "Rebuild gestartet. Status aktualisiert sich automatisch.",
  };
}
