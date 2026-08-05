import { existsSync, readFileSync } from "fs";
import { writeGeneratedText } from "@/lib/localData/fs";
import { resolveWritablePath } from "@/lib/localData/paths";
import type { ExportGroupId, ExportGroupsOrgState } from "./types";
import { EXPORT_GROUP_IDS } from "./types";

const STATE_FILE = "export-groups-org.json";

/** Org point keys shared across groups (Area 3 flow). */
export const ORG_POINT_KEYS = [
  "report_ready",
  "sap_prepared",
  "export_executed",
  "files_placed",
] as const;

export type OrgPointKey = (typeof ORG_POINT_KEYS)[number];

/** Z-/Y-specific org keys (definitions/contents filing). */
export const ZY_ORG_POINT_KEYS = [
  "report_ready",
  "export_executed",
  "definitions_filed",
  "contents_filed",
] as const;

export type ZyOrgPointKey = (typeof ZY_ORG_POINT_KEYS)[number];

function nowIso(): string {
  return new Date().toISOString();
}

export function createEmptyOrgState(projectKey: string): ExportGroupsOrgState {
  return {
    schema_version: 1,
    project: projectKey,
    updated_at: nowIso(),
    groups: {},
  };
}

export function loadExportGroupsOrgState(
  projectKey: string,
): ExportGroupsOrgState {
  try {
    const abs = resolveWritablePath(projectKey, "logs", STATE_FILE);
    if (!existsSync(abs)) return createEmptyOrgState(projectKey);
    const raw = JSON.parse(readFileSync(abs, "utf8")) as ExportGroupsOrgState;
    if (raw?.schema_version !== 1) return createEmptyOrgState(projectKey);
    return raw;
  } catch {
    return createEmptyOrgState(projectKey);
  }
}

export function isOrgConfirmed(
  state: ExportGroupsOrgState,
  groupId: ExportGroupId,
  key: string,
): boolean {
  return Boolean(state.groups[groupId]?.[key]?.confirmed);
}

export function setOrgConfirmation(params: {
  projectKey: string;
  groupId: ExportGroupId;
  key: string;
  confirmed: boolean;
}): ExportGroupsOrgState {
  const { projectKey, groupId, key, confirmed } = params;
  if (!(EXPORT_GROUP_IDS as readonly string[]).includes(groupId)) {
    throw new Error(`Unbekannte Exportgruppe: ${groupId}`);
  }
  const state = loadExportGroupsOrgState(projectKey);
  const group = { ...(state.groups[groupId] ?? {}) };
  if (confirmed) {
    group[key] = { confirmed: true, at: nowIso() };
  } else {
    delete group[key];
  }
  const next: ExportGroupsOrgState = {
    ...state,
    project: projectKey,
    updated_at: nowIso(),
    groups: { ...state.groups, [groupId]: group },
  };
  writeGeneratedText(
    projectKey,
    "logs",
    STATE_FILE,
    `${JSON.stringify(next, null, 2)}\n`,
  );
  return next;
}
