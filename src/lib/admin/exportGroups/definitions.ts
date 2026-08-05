import type { ExportGroupDefinition, ExportGroupId } from "./types";
import { EXPORT_GROUP_IDS } from "./types";

/** Three export groups for Area 3 — Z-/Y is the wired reference. */
export const EXPORT_GROUP_DEFINITIONS: Record<
  ExportGroupId,
  ExportGroupDefinition
> = {
  "zy-tables": {
    id: "zy-tables",
    title: "Z-/Y-Tabellen",
    description:
      "Control Tables (Z-/Y): Report exportieren, Dateien in RAW ablegen, App erkennt Quellen",
    sapReport: "Z_AI_REPOSITORY_EXPORT",
    exportType: "Z-Tabellen",
    expectedSourceFiles: [
      "raw/control-tables/definitions/*.jsonl",
      "raw/control-tables/contents/*.jsonl",
    ],
    rawTargetPaths: [
      "raw/control-tables/definitions",
      "raw/control-tables/contents",
    ],
    dependencies: [],
    requiredForMainProgress: true,
    pipeline: "control-tables",
  },
  "classes-repo": {
    id: "classes-repo",
    title: "Klassen und Repository-Objekte",
    description:
      "Rahmen für Klassen, Programme, FBs, UserExits, BAdIs, Enhancements und Repo-Beziehungen — noch ohne eigene Konvertierung",
    sapReport: "Z_AI_REPOSITORY_EXPORT",
    exportType: "Repository-Objekte",
    expectedSourceFiles: ["raw/classes/*", "raw/programs/*"],
    rawTargetPaths: ["raw/classes", "raw/programs"],
    dependencies: [],
    requiredForMainProgress: false,
    pipeline: "prepared",
    preparedSubtypes: [
      "Klassen",
      "Programme",
      "Funktionsbausteine",
      "UserExits",
      "BAdIs",
      "Enhancements",
      "Repo-Beziehungen",
    ],
  },
  "master-data": {
    id: "master-data",
    title: "Stammdaten",
    description:
      "Materialien (Datenbasis-Pipeline materials), Kunden und Lieferanten unter raw/master-data/*",
    sapReport: "—",
    exportType: "Stammdaten",
    expectedSourceFiles: [
      "raw/master-data/materials/*",
      "raw/master-data/customers/*",
      "raw/master-data/vendors/*",
    ],
    rawTargetPaths: [
      "raw/master-data/materials",
      "raw/master-data/customers",
      "raw/master-data/vendors",
    ],
    dependencies: [],
    requiredForMainProgress: false,
    pipeline: "prepared",
    preparedSubtypes: ["Materialien", "Kunden", "Lieferanten"],
  },
};

export function isExportGroupId(raw: string | undefined): raw is ExportGroupId {
  return Boolean(raw && (EXPORT_GROUP_IDS as readonly string[]).includes(raw));
}

export function listExportGroupDefinitions(): ExportGroupDefinition[] {
  return EXPORT_GROUP_IDS.map((id) => EXPORT_GROUP_DEFINITIONS[id]);
}

export function exportGroupDetailHref(
  stepId: 3 | 4 | 5,
  groupId: ExportGroupId,
  customerId?: string | null,
): string {
  const base = `/admin/steps/${stepId}/${groupId}`;
  if (!customerId) return base;
  return `${base}?customer=${encodeURIComponent(customerId)}`;
}
