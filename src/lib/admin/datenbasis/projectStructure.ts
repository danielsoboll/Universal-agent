/**
 * Stage 2: project folder structure check / create only.
 * No content checks (input/raw files). RAW: empty scaffold dirs only — never write RAW files.
 */

import { existsSync, mkdirSync, readFileSync, statSync } from "fs";
import path from "path";
import {
  assertProjectKey,
  assertPathWithinRoot,
  resolveLocalPath,
  resolveProjectZonePath,
  resolveRawPath,
} from "@/lib/localData/paths";
import { DATA_ZONES, type DataZone } from "@/lib/localData/zones";
import { getLocalDataRoot } from "@/lib/localData/root";
import {
  ensureWritableDir,
  writeGeneratedText,
} from "@/lib/localData/fs";
import { listScaffoldRawFolderParts } from "@/lib/admin/datenbasis/exportTypeConfig";
import type { SetupStage2State } from "@/lib/admin/datenbasis/types";

const STAGE2_FILE = "setup-stage2.json";

function nowIso(): string {
  return new Date().toISOString();
}

function dirOk(abs: string): boolean {
  try {
    return existsSync(abs) && statSync(abs).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Create an empty directory under raw/ for scaffold only.
 * Never writes files into raw/. Documented exception to RAW read-only file policy.
 */
export function ensureRawScaffoldDir(
  projectKey: string,
  ...folderParts: string[]
): string {
  const key = assertProjectKey(projectKey);
  const abs = resolveRawPath(key, ...folderParts);
  assertPathWithinRoot(abs);
  // Extra guard: must stay under .../raw/
  const rel = path.relative(resolveLocalPath(key, "raw"), abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`RAW-Scaffold außerhalb von raw/: ${abs}`);
  }
  mkdirSync(abs, { recursive: true });
  return abs;
}

export type StructureCheckResult = {
  ok: boolean;
  projectRoot: string;
  present: string[];
  missing: string[];
  zones: Record<DataZone, boolean>;
  rawScaffolds: Array<{ relative: string; ok: boolean }>;
};

export function checkProjectStructure(projectKey: string): StructureCheckResult {
  const key = assertProjectKey(projectKey);
  getLocalDataRoot();
  const projectRoot = resolveLocalPath(key);
  const present: string[] = [];
  const missing: string[] = [];

  if (dirOk(projectRoot)) present.push(key);
  else missing.push(key);

  const zones = {} as Record<DataZone, boolean>;
  for (const zone of DATA_ZONES) {
    const abs = resolveProjectZonePath(key, zone);
    const ok = dirOk(abs);
    zones[zone] = ok;
    const rel = `${key}/${zone}`;
    if (ok) present.push(rel);
    else missing.push(rel);
  }

  const rawScaffolds = listScaffoldRawFolderParts().map((parts) => {
    const relative = `raw/${parts.join("/")}`;
    const abs = resolveRawPath(key, ...parts);
    const ok = dirOk(abs);
    if (ok) present.push(`${key}/${relative}`);
    else missing.push(`${key}/${relative}`);
    return { relative, ok };
  });

  const ok =
    dirOk(projectRoot) &&
    DATA_ZONES.every((z) => zones[z]) &&
    rawScaffolds.every((s) => s.ok);

  return { ok, projectRoot, present, missing, zones, rawScaffolds };
}

export function ensureProjectStructure(projectKey: string): StructureCheckResult {
  const key = assertProjectKey(projectKey);
  getLocalDataRoot();
  const projectRoot = resolveLocalPath(key);
  mkdirSync(projectRoot, { recursive: true });

  for (const zone of DATA_ZONES) {
    if (zone === "raw") {
      mkdirSync(resolveProjectZonePath(key, "raw"), { recursive: true });
    } else {
      ensureWritableDir(key, zone);
    }
  }

  const created: string[] = [];
  for (const parts of listScaffoldRawFolderParts()) {
    const abs = ensureRawScaffoldDir(key, ...parts);
    created.push(abs);
  }

  // Writable scaffolds for message-idoc-config (empty dirs only)
  created.push(
    ensureWritableDir(key, "canonical", "message-idoc-config"),
    ensureWritableDir(key, "logs", "message-idoc-config"),
    ensureWritableDir(key, "logs", "message-idoc-config", "schema-profiles"),
  );

  const check = checkProjectStructure(key);
  const state = loadSetupStage2State(key);
  const next: SetupStage2State = {
    ...state,
    folders_ok: check.ok,
    folders_checked_at: nowIso(),
    created_paths: [
      ...new Set([
        ...state.created_paths,
        ...created.map((a) => path.relative(getLocalDataRoot(), a)),
      ]),
    ],
    missing_paths: check.missing,
    updated_at: nowIso(),
  };
  saveSetupStage2State(key, next);
  return check;
}

export function createInitialSetupStage2State(
  projectKey: string,
): SetupStage2State {
  return {
    schema_version: 1,
    project: projectKey,
    folders_ok: false,
    folders_checked_at: null,
    manual_complete: false,
    manual_complete_at: null,
    created_paths: [],
    missing_paths: [],
    updated_at: nowIso(),
  };
}

export function loadSetupStage2State(projectKey: string): SetupStage2State {
  const key = assertProjectKey(projectKey);
  try {
    getLocalDataRoot();
    const abs = resolveProjectZonePath(key, "logs", STAGE2_FILE);
    if (!existsSync(abs)) return createInitialSetupStage2State(key);
    const raw = JSON.parse(readFileSync(abs, "utf8")) as SetupStage2State;
    if (raw?.schema_version !== 1) return createInitialSetupStage2State(key);
    return { ...createInitialSetupStage2State(key), ...raw, project: key };
  } catch {
    return createInitialSetupStage2State(key);
  }
}

export function saveSetupStage2State(
  projectKey: string,
  state: SetupStage2State,
): void {
  const key = assertProjectKey(projectKey);
  ensureWritableDir(key, "logs");
  writeGeneratedText(
    key,
    "logs",
    STAGE2_FILE,
    `${JSON.stringify(state, null, 2)}\n`,
  );
}

/** Reconcile Stage 2: disk folders + persisted manual_complete. */
export function reconcileSetupStage2(projectKey: string): SetupStage2State {
  const key = assertProjectKey(projectKey);
  let state = loadSetupStage2State(key);
  try {
    getLocalDataRoot();
    const check = checkProjectStructure(key);
    state = {
      ...state,
      folders_ok: check.ok,
      folders_checked_at: nowIso(),
      missing_paths: check.missing,
      updated_at: nowIso(),
    };
    saveSetupStage2State(key, state);
  } catch {
    state = {
      ...state,
      folders_ok: false,
      updated_at: nowIso(),
    };
  }
  return state;
}

export function confirmStage2Complete(
  projectKey: string,
  complete: boolean,
): SetupStage2State {
  const key = assertProjectKey(projectKey);
  const check = checkProjectStructure(key);
  if (complete && !check.ok) {
    throw new Error(
      `Ordnerstruktur unvollständig — zuerst anlegen. Fehlt: ${check.missing.slice(0, 5).join(", ")}`,
    );
  }
  const state = loadSetupStage2State(key);
  const next: SetupStage2State = {
    ...state,
    folders_ok: check.ok,
    folders_checked_at: nowIso(),
    missing_paths: check.missing,
    manual_complete: complete,
    manual_complete_at: complete ? nowIso() : null,
    updated_at: nowIso(),
  };
  saveSetupStage2State(key, next);
  return next;
}

/** Stage 2 is done when folders exist AND admin manually confirmed. */
export function isStage2Done(state: SetupStage2State): boolean {
  return state.folders_ok && state.manual_complete;
}
