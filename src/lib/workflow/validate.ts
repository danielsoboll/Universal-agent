import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import path from "path";
import type { LocalProject } from "@/lib/localAuth/types";
import { projectDataRoot } from "@/lib/workflow/placeholders";
import type { ResolvedWorkflowStep } from "@/lib/workflow/resolve";
import type { StepCheckResult } from "@/lib/workflow/types";
import { UNCONFIGURED } from "@/lib/workflow/types";

function matchGlob(name: string, pattern: string): boolean {
  if (pattern === "*") return true;
  if (pattern.startsWith("*.")) {
    return name.toLowerCase().endsWith(pattern.slice(1).toLowerCase());
  }
  if (pattern.includes("*")) {
    const re = new RegExp(
      `^${pattern
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*")}$`,
      "i",
    );
    return re.test(name);
  }
  return name === pattern;
}

function listMatches(dir: string, pattern: string): string[] {
  if (!existsSync(dir)) return [];
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries
    .filter((name) => !name.startsWith("."))
    .filter((name) => matchGlob(name, pattern))
    .map((name) => path.join(dir, name));
}

function validateJsonlFile(filePath: string): string[] {
  const errors: string[] = [];
  let st;
  try {
    st = statSync(filePath);
  } catch {
    return [`Nicht lesbar: ${filePath}`];
  }
  if (!st.isFile()) return [`Keine Datei: ${filePath}`];
  if (st.size <= 0) return [`Datei leer: ${path.basename(filePath)}`];

  let text: string;
  try {
    text = readFileSync(filePath, "utf8");
  } catch {
    return [`Lesen fehlgeschlagen: ${path.basename(filePath)}`];
  }
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length === 0) {
    return [`Keine JSON-Zeilen: ${path.basename(filePath)}`];
  }
  const sample = lines.slice(0, Math.min(20, lines.length));
  for (let i = 0; i < sample.length; i++) {
    try {
      JSON.parse(sample[i]!);
    } catch {
      errors.push(
        `Ungültiges JSON in ${path.basename(filePath)} Zeile ${i + 1}`,
      );
      break;
    }
  }
  return errors;
}

function checkDirectoryHasJsonl(
  dir: string,
  pattern = "*.jsonl",
): { ok: boolean; messages: string[]; files: string[] } {
  if (!existsSync(dir)) {
    return { ok: false, messages: [`Ordner fehlt: ${dir}`], files: [] };
  }
  const files = listMatches(dir, pattern);
  if (files.length === 0) {
    return {
      ok: false,
      messages: [`Keine Datei für Muster ${pattern} in ${dir}`],
      files: [],
    };
  }
  const messages: string[] = [];
  for (const f of files) {
    if (f.toLowerCase().endsWith(".jsonl")) {
      messages.push(...validateJsonlFile(f));
    } else {
      try {
        if (statSync(f).size <= 0) {
          messages.push(`Datei leer: ${path.basename(f)}`);
        }
      } catch {
        messages.push(`Nicht lesbar: ${path.basename(f)}`);
      }
    }
  }
  return { ok: messages.length === 0, messages, files };
}

function checkPathExists(
  projectRoot: string,
  rel: string,
): { ok: boolean; message: string; file?: string } {
  const abs = path.isAbsolute(rel)
    ? rel
    : projectRoot
      ? path.join(projectRoot, rel)
      : rel;
  if (!existsSync(abs)) {
    return { ok: false, message: `Fehlt: ${rel}` };
  }
  const st = statSync(abs);
  if (st.isDirectory()) {
    return { ok: true, message: `OK: ${rel}`, file: abs };
  }
  if (st.size <= 0) {
    return { ok: false, message: `Datei leer: ${rel}` };
  }
  if (abs.toLowerCase().endsWith(".jsonl")) {
    const errs = validateJsonlFile(abs);
    if (errs.length) return { ok: false, message: errs[0]! };
  }
  return { ok: true, message: `OK: ${rel}`, file: abs };
}

export function validateWorkflowStep(
  project: LocalProject,
  step: ResolvedWorkflowStep,
): StepCheckResult {
  const at = new Date().toISOString();
  const root = projectDataRoot(project);
  const messages: string[] = [];
  const matched: string[] = [];

  if (step.destination_path.includes(UNCONFIGURED)) {
    return {
      at,
      ok: false,
      messages: [
        `Zielpfad enthält „${UNCONFIGURED}“ – zuerst Projektkonfiguration prüfen.`,
      ],
      matched_files: [],
    };
  }

  if (step.output_checks.length > 0) {
    for (const check of step.output_checks) {
      if (check.includes("*")) {
        const dirRel = path.dirname(check);
        const pattern = path.basename(check);
        const dir = path.join(root, dirRel === "." ? "" : dirRel);
        const result = checkDirectoryHasJsonl(
          dir,
          pattern === "*" ? "*.jsonl" : pattern,
        );
        matched.push(...result.files);
        messages.push(...result.messages);
        if (result.ok) messages.push(`OK: ${check}`);
      } else {
        const r = checkPathExists(root, check);
        if (r.file) matched.push(r.file);
        messages.push(r.message);
      }
    }
    const failures = messages.filter((m) => !m.startsWith("OK:"));
    return {
      at,
      ok: failures.length === 0,
      messages: failures.length ? failures : messages,
      matched_files: matched,
    };
  }

  for (const pattern of step.file_patterns) {
    if (pattern.includes("/")) {
      const [subdir, filePat] = pattern.split("/") as [string, string];
      const dir = path.join(step.destination_path, subdir);
      const result = checkDirectoryHasJsonl(dir, filePat || "*.jsonl");
      matched.push(...result.files);
      messages.push(...result.messages);
      if (result.ok) messages.push(`OK: ${pattern}`);
      continue;
    }

    const dest = step.destination_path;
    const destIsFile =
      /\.(json|jsonl)$/i.test(dest) ||
      (existsSync(dest) && statSync(dest).isFile());

    if (destIsFile) {
      const r = checkPathExists("", dest);
      if (r.file) matched.push(r.file);
      messages.push(r.ok ? `OK: ${path.basename(dest)}` : r.message);
      continue;
    }

    const result = checkDirectoryHasJsonl(dest, pattern);
    matched.push(...result.files);
    messages.push(...result.messages);
    if (result.ok) {
      messages.push(`OK: ${pattern} in ${dest}`);
    }
  }

  if (step.file_patterns.length === 0 && step.output_checks.length === 0) {
    if (existsSync(step.destination_path)) {
      messages.push(`OK: Pfad existiert (${step.destination_path})`);
    } else {
      messages.push(`Pfad fehlt: ${step.destination_path}`);
    }
  }

  const failures = messages.filter((m) => !m.startsWith("OK:"));
  return {
    at,
    ok: failures.length === 0 && messages.length > 0,
    messages: failures.length ? failures : messages,
    matched_files: matched,
  };
}

export function resolveCheckPathForOpen(
  project: LocalProject,
  step: ResolvedWorkflowStep,
): string {
  const root = projectDataRoot(project);
  if (
    step.destination_path &&
    !step.destination_path.includes(UNCONFIGURED) &&
    existsSync(step.destination_path)
  ) {
    return step.destination_path;
  }
  if (step.output_checks[0]) {
    const p = path.join(root, step.output_checks[0]);
    return existsSync(p) ? p : path.dirname(p);
  }
  return root;
}
