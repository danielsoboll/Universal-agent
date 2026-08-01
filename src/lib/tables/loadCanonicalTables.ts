import { existsSync, readFileSync } from "fs";
import type {
  CanonicalTableClassification,
  CanonicalTableDefinition,
  CanonicalTableRow,
} from "@/lib/ingest/controlTables/model";
import { resolveWritablePath } from "@/lib/localData/paths";

export type CodeTableAccessLog = {
  code_source_key: string;
  method_name?: string;
  access_kind?: string;
  table_name: string;
  selected_fields?: string[];
  where?: Array<{
    field?: string;
    operator?: string;
    value_kind?: string;
    raw_value?: string;
    resolved_literal?: string;
  }>;
  evidence_code?: string;
  line_start?: number;
};

export type CodeTableLinkRecord = {
  source_key: string;
  relation_type: string;
  from_type: string;
  from_key: string;
  to_type: string;
  to_key: string;
  confidence?: number;
  metadata?: Record<string, unknown>;
  evidence_from_code?: string[];
  evidence_from_table?: string[];
  content_hash?: string;
};

export type DynamicAccessRecord = {
  code_source_key?: string;
  table_name?: string;
  access_kind?: string;
  unresolved_reason?: string;
  evidence?: string[];
  line_start?: number;
};

export type IngestReport = {
  stats?: {
    duplicates?: number;
    key_collisions?: number;
    tables_with_rows?: number;
    incomplete_keys?: number;
  };
};

export type TableCorpusBundle = {
  projectKey: string;
  definitions: CanonicalTableDefinition[];
  classifications: CanonicalTableClassification[];
  rows: CanonicalTableRow[];
  links: CodeTableLinkRecord[];
  accesses: CodeTableAccessLog[];
  dynamicAccesses: DynamicAccessRecord[];
  ingestReport: IngestReport | null;
  classificationByTable: Map<string, CanonicalTableClassification>;
  definitionByTable: Map<string, CanonicalTableDefinition>;
  rowsByTable: Map<string, CanonicalTableRow[]>;
};

function readJsonl<T>(absolute: string): T[] {
  if (!existsSync(absolute)) return [];
  return readFileSync(absolute, "utf8")
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as T);
}

function readJson<T>(absolute: string): T | null {
  if (!existsSync(absolute)) return null;
  return JSON.parse(readFileSync(absolute, "utf8")) as T;
}

function indexCorpusMaps(params: {
  definitions: CanonicalTableDefinition[];
  classifications: CanonicalTableClassification[];
  rows: CanonicalTableRow[];
}): Pick<
  TableCorpusBundle,
  "classificationByTable" | "definitionByTable" | "rowsByTable"
> {
  const classificationByTable = new Map(
    params.classifications.map((c) => [c.table_name, c]),
  );
  const definitionByTable = new Map(
    params.definitions.map((d) => [d.table_name, d]),
  );
  const rowsByTable = new Map<string, CanonicalTableRow[]>();
  for (const row of params.rows) {
    const list = rowsByTable.get(row.table_name) ?? [];
    list.push(row);
    rowsByTable.set(row.table_name, list);
  }
  return { classificationByTable, definitionByTable, rowsByTable };
}

function loadCodeSideArtifacts(projectKey: string): {
  links: CodeTableLinkRecord[];
  accesses: CodeTableAccessLog[];
  dynamicAccesses: DynamicAccessRecord[];
} {
  const linkPath = resolveWritablePath(
    projectKey,
    "canonical",
    "relations/code_table_links.jsonl",
  );
  const accessPath = resolveWritablePath(
    projectKey,
    "logs",
    "code_table_accesses.jsonl",
  );
  const dynPath = resolveWritablePath(
    projectKey,
    "analyses",
    "relations/dynamic_table_accesses.jsonl",
  );
  return {
    links: readJsonl<CodeTableLinkRecord>(linkPath),
    accesses: readJsonl<CodeTableAccessLog>(accessPath),
    dynamicAccesses: readJsonl<DynamicAccessRecord>(dynPath),
  };
}

/**
 * Build corpus from in-memory canonical (staging) + existing code-side artifacts.
 * Does not read control-table canonical from disk — used for prepare-then-swap.
 */
export function buildTableCorpusFromCanonical(params: {
  projectKey: string;
  definitions: CanonicalTableDefinition[];
  classifications: CanonicalTableClassification[];
  rows: CanonicalTableRow[];
  ingestReport?: IngestReport | null;
}): TableCorpusBundle {
  const side = loadCodeSideArtifacts(params.projectKey);
  const maps = indexCorpusMaps(params);
  return {
    projectKey: params.projectKey,
    definitions: params.definitions,
    classifications: params.classifications,
    rows: params.rows,
    links: side.links,
    accesses: side.accesses,
    dynamicAccesses: side.dynamicAccesses,
    ingestReport: params.ingestReport ?? null,
    ...maps,
  };
}

export function loadTableCorpus(projectKey: string): TableCorpusBundle {
  const defPath = resolveWritablePath(
    projectKey,
    "canonical",
    "control-tables/table_definitions.jsonl",
  );
  const clsPath = resolveWritablePath(
    projectKey,
    "canonical",
    "control-tables/table_classifications.jsonl",
  );
  const rowPath = resolveWritablePath(
    projectKey,
    "canonical",
    "control-tables/table_rows.jsonl",
  );
  const ingestPath = resolveWritablePath(
    projectKey,
    "canonical",
    "control-tables/ingest_report.json",
  );

  const definitions = readJsonl<CanonicalTableDefinition>(defPath);
  const classifications = readJsonl<CanonicalTableClassification>(clsPath);
  const rows = readJsonl<CanonicalTableRow>(rowPath);
  const ingestReport = readJson<IngestReport>(ingestPath);
  const side = loadCodeSideArtifacts(projectKey);
  const maps = indexCorpusMaps({ definitions, classifications, rows });

  return {
    projectKey,
    definitions,
    classifications,
    rows,
    links: side.links,
    accesses: side.accesses,
    dynamicAccesses: side.dynamicAccesses,
    ingestReport,
    ...maps,
  };
}

export function extractLinkedTableNames(bundle: TableCorpusBundle): Set<string> {
  const out = new Set<string>();
  for (const a of bundle.accesses) {
    if (a.table_name) out.add(a.table_name);
  }
  for (const d of bundle.dynamicAccesses) {
    if (d.table_name) out.add(d.table_name);
  }
  for (const l of bundle.links) {
    const metaTable = l.metadata?.table_name;
    if (typeof metaTable === "string" && metaTable) out.add(metaTable);
    if (l.to_type === "TABLE" && l.to_key) {
      const bare = l.to_key.includes("|")
        ? l.to_key.split("|").slice(-1)[0]!
        : l.to_key;
      // D01|001|ZEXTO_PARAMETER → ZEXTO_PARAMETER
      if (l.to_key.includes("|")) {
        const parts = l.to_key.split("|");
        out.add(parts[parts.length - 1]!);
      } else {
        out.add(bare);
      }
    }
  }
  return out;
}
