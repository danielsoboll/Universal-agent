import type {
  RebuildDataType,
  RebuildRunReport,
  RebuildTypeReport,
} from "@/lib/rebuild/types";
import { REBUILD_DATA_TYPES } from "@/lib/rebuild/types";
import { rebuildControlTables } from "@/lib/rebuild/rebuildControlTables";

export function parseRebuildType(value: string | undefined): RebuildDataType | "all" {
  const v = (value ?? "").trim().toLowerCase();
  if (v === "all") return "all";
  if ((REBUILD_DATA_TYPES as readonly string[]).includes(v)) {
    return v as RebuildDataType;
  }
  throw new Error(
    `Ungültiger Typ "${value}". Erlaubt: ${REBUILD_DATA_TYPES.join("|")}|all`,
  );
}

function skippedTypeReport(
  type: RebuildDataType,
  projectKey: string,
  detail: string,
): RebuildTypeReport {
  const now = new Date().toISOString();
  return {
    project: projectKey,
    type,
    source_files: [],
    source_sizes: [],
    source_sha256: [],
    lines_read: 0,
    structural_validation_ok: false,
    error_count: 0,
    canonical_records: 0,
    search_documents: 0,
    embeddings: 0,
    index_entries: 0,
    old_deleted: false,
    success: false,
    smoke_ok: false,
    derived_replaced: false,
    no_new_folder_structure: true,
    smoke: [{ name: "Typ unterstützt", ok: false, detail }],
    steps_completed: [],
    at: now,
    duration_ms: 0,
    error: detail,
  };
}

export async function rebuildData(params: {
  projectKey: string;
  customerId: string;
  systemId: string;
  type: RebuildDataType | "all";
  onTypeStep?: (
    type: RebuildDataType,
    step: string,
    detail?: string,
  ) => void;
}): Promise<RebuildRunReport> {
  const started = Date.now();
  const now = new Date().toISOString();
  const types: RebuildDataType[] =
    params.type === "all" ? [...REBUILD_DATA_TYPES] : [params.type];

  const results: RebuildTypeReport[] = [];
  for (const type of types) {
    if (type === "control-tables") {
      const report = await rebuildControlTables({
        projectKey: params.projectKey,
        customerId: params.customerId,
        systemId: params.systemId,
        onStep: (step, detail) => params.onTypeStep?.(type, step, detail),
      });
      results.push(report);
      continue;
    }

    if (params.type === "all") {
      results.push(
        skippedTypeReport(
          type,
          params.projectKey,
          `Typ ${type} noch nicht implementiert — übersprungen`,
        ),
      );
      continue;
    }

    throw new Error(
      `Rebuild für Typ "${type}" ist noch nicht implementiert ` +
        `(Projekt ${params.projectKey}). Derzeit vollständig unterstützt: control-tables.`,
    );
  }

  return {
    project: params.projectKey,
    types,
    results,
    at: now,
    duration_ms: Date.now() - started,
  };
}
