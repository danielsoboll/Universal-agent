import {
  deleteGeneratedPath,
  listWritableEntries,
} from "@/lib/localData/fs";
import type { RebuildDataType } from "@/lib/rebuild/types";
import type { WritableZone } from "@/lib/localData/zones";

export type WipeResult = {
  deleted_paths: string[];
};

type WipeTarget = { zone: WritableZone; relativePath: string };

/** Derived paths to wipe per data type (never raw/). */
const WIPE_TARGETS: Record<RebuildDataType, WipeTarget[]> = {
  "control-tables": [
    { zone: "canonical", relativePath: "control-tables" },
    { zone: "analyses", relativePath: "control-tables" },
    { zone: "indexes", relativePath: "tables" },
    { zone: "embeddings", relativePath: "search/control_tables_embeddings.jsonl" },
    { zone: "logs", relativePath: "control-tables-ingest-issues.jsonl" },
    { zone: "logs", relativePath: "tables" },
  ],
  classes: [
    { zone: "canonical", relativePath: "classes" },
    { zone: "analyses", relativePath: "classes" },
    { zone: "indexes", relativePath: "classes" },
    { zone: "logs", relativePath: "datenbasis/classes" },
    { zone: "logs", relativePath: "datenbasis/classes-pipeline.json" },
    { zone: "logs", relativePath: "datenbasis-classes.log" },
    { zone: "logs", relativePath: "canonicalize-sap-classes.log" },
  ],
  programs: [{ zone: "canonical", relativePath: "programs" }],
  materials: [{ zone: "canonical", relativePath: "master-data/materials" }],
  customers: [{ zone: "canonical", relativePath: "master-data/customers" }],
  vendors: [{ zone: "canonical", relativePath: "master-data/vendors" }],
};

/**
 * Deletes only derived data for the given type.
 * Raw is never touched. No new folder structure is created here.
 */
export function wipeDerivedForType(params: {
  projectKey: string;
  type: RebuildDataType;
}): WipeResult {
  const deleted_paths: string[] = [];
  for (const target of WIPE_TARGETS[params.type]) {
    const result = deleteGeneratedPath(
      params.projectKey,
      target.zone,
      target.relativePath,
    );
    if (result.deleted) {
      deleted_paths.push(`${target.zone}/${target.relativePath}`);
    }
  }

  // Optional findings zone files if present under analyses/relations leftovers
  // are already covered by type-specific targets above.

  // Clear any leftover single files under indexes/tables parent listing
  if (params.type === "control-tables") {
    const leftovers = listWritableEntries(params.projectKey, "indexes").filter(
      (n) => n === "tables",
    );
    for (const name of leftovers) {
      const result = deleteGeneratedPath(params.projectKey, "indexes", name);
      if (result.deleted) deleted_paths.push(`indexes/${name}`);
    }
  }

  return { deleted_paths: [...new Set(deleted_paths)] };
}

/** Source types / knowledge unit types that belong to control-tables corpus. */
export const CONTROL_TABLE_HYBRID_SOURCE_TYPES = new Set([
  "control_table_analysis",
  "canonical_table_row",
  "table_knowledge_unit",
  "table_rule_group",
  "table_business_rule_bundle",
  "code_table_binding",
]);

export const CONTROL_TABLE_HYBRID_KNOWLEDGE_TYPES = new Set([
  "control_table",
  "control_table_row",
  "table_profile",
  "table_row",
  "table_rule_group",
]);

export function isControlTableHybridDocument(doc: {
  source_type?: string;
  knowledge_unit_type?: string;
}): boolean {
  if (doc.source_type && CONTROL_TABLE_HYBRID_SOURCE_TYPES.has(doc.source_type)) {
    return true;
  }
  if (
    doc.knowledge_unit_type &&
    CONTROL_TABLE_HYBRID_KNOWLEDGE_TYPES.has(doc.knowledge_unit_type)
  ) {
    return true;
  }
  return false;
}

/** Source / knowledge types from classes (code unit) ingest in hybrid search. */
export const CLASS_HYBRID_SOURCE_TYPES = new Set([
  "code_unit_analysis",
]);

export const CLASS_HYBRID_KNOWLEDGE_TYPES = new Set([
  "code_unit",
]);

export function isClassHybridDocument(doc: {
  source_type?: string;
  knowledge_unit_type?: string;
  object_type?: string;
}): boolean {
  if (doc.source_type && CLASS_HYBRID_SOURCE_TYPES.has(doc.source_type)) {
    return true;
  }
  if (
    doc.knowledge_unit_type &&
    CLASS_HYBRID_KNOWLEDGE_TYPES.has(doc.knowledge_unit_type)
  ) {
    return true;
  }
  if (String(doc.object_type ?? "").toUpperCase() === "CLASS") {
    return true;
  }
  return false;
}
