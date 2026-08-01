import { spawnSync } from "child_process";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import path from "path";
import type { LocalProject } from "@/lib/localAuth/types";
import type { ResolvedWorkflowStep } from "@/lib/workflow/resolve";
import { projectDataRoot } from "@/lib/workflow/placeholders";

export type RunCommandResult = {
  ok: boolean;
  exit_code: number | null;
  stdout: string;
  stderr: string;
  command: string;
};

export function runWorkflowCli(
  project: LocalProject,
  step: ResolvedWorkflowStep,
): RunCommandResult {
  const cwd = process.cwd();
  let command = step.cli_command?.trim() || "";

  if (!command && step.npm_script) {
    if (step.npm_script === "pipeline" && step.id === "prep.init_layout") {
      command = `npm run pipeline -- --customer ${project.customer_id} --system ${project.system_id} --init-layout`;
    } else if (step.pipeline_key) {
      command = `npm run pipeline -- --customer ${project.customer_id} --system ${project.system_id} --step ${step.pipeline_key}`;
    } else {
      command = `npm run ${step.npm_script}`;
      if (step.npm_script === "index:tables") {
        command += ` -- --customer ${project.customer_id} --system ${project.system_id}`;
      }
    }
  }

  if (!command) {
    return {
      ok: false,
      exit_code: null,
      stdout: "",
      stderr: "Kein CLI-Befehl für diesen Schritt konfiguriert.",
      command: "",
    };
  }

  // Prefer shell for npm run with extra args
  const result = spawnSync(command, {
    cwd,
    env: process.env,
    encoding: "utf8",
    shell: true,
    timeout: 15 * 60 * 1000,
    maxBuffer: 8 * 1024 * 1024,
  });

  return {
    ok: result.status === 0,
    exit_code: result.status,
    stdout: (result.stdout || "").slice(-12000),
    stderr: (result.stderr || "").slice(-12000),
    command,
  };
}

export function openLocalPath(targetPath: string): RunCommandResult {
  if (!existsSync(targetPath)) {
    return {
      ok: false,
      exit_code: null,
      stdout: "",
      stderr: `Pfad existiert nicht: ${targetPath}`,
      command: `open ${targetPath}`,
    };
  }
  const cmd =
    process.platform === "darwin"
      ? `open "${targetPath}"`
      : process.platform === "win32"
        ? `explorer "${targetPath}"`
        : `xdg-open "${targetPath}"`;
  const result = spawnSync(cmd, {
    encoding: "utf8",
    shell: true,
    timeout: 10_000,
  });
  return {
    ok: result.status === 0,
    exit_code: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    command: cmd,
  };
}

export function writeUploadedFiles(
  project: LocalProject,
  destinationDir: string,
  files: Array<{ name: string; bytes: Buffer }>,
): { ok: boolean; messages: string[]; written: string[] } {
  const root = projectDataRoot(project);
  const abs = path.isAbsolute(destinationDir)
    ? destinationDir
    : path.join(root, destinationDir);

  if (!abs.startsWith(root)) {
    return {
      ok: false,
      messages: ["Upload-Ziel liegt außerhalb des Projektordners."],
      written: [],
    };
  }

  if (!existsSync(abs)) mkdirSync(abs, { recursive: true });

  const written: string[] = [];
  const messages: string[] = [];
  for (const f of files) {
    const safe = path.basename(f.name).replace(/[^\w.\-()+]/g, "_");
    if (!safe.toLowerCase().endsWith(".jsonl")) {
      messages.push(`Übersprungen (kein .jsonl): ${f.name}`);
      continue;
    }
    const target = path.join(abs, safe);
    writeFileSync(target, f.bytes);
    written.push(target);
    messages.push(`Geschrieben: ${safe}`);
  }
  return { ok: written.length > 0, messages, written };
}
