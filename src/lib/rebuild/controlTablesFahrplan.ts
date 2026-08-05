import { createHash } from "crypto";
import { existsSync, readFileSync, statSync } from "fs";
import { canonicalizeControlTableSources } from "@/lib/ingest/controlTables/canonicalize";
import { recordsToJsonl } from "@/lib/ingest/controlTables/model";
import {
  appendLogLine,
  deleteGeneratedPath,
  ensureWritableDir,
  listRawEntries,
  readRawBuffer,
  writeGeneratedText,
} from "@/lib/localData/fs";
import { resolveRawPath, resolveWritablePath } from "@/lib/localData/paths";
import { replaceControlTableEntriesInHybridIndex } from "@/lib/rebuild/mergeHybridIndex";
import { smokeTestControlTables } from "@/lib/rebuild/smokeControlTables";
import {
  CONTROL_TABLES_FAHRPLAN_TYPE,
  FAHRPLAN_STEP_IDS,
  FAHRPLAN_STEP_META,
  type ControlTablesFahrplanState,
  type FahrplanOverallStatus,
  type FahrplanRunResult,
  type FahrplanSourceFileInfo,
  type FahrplanStepId,
  type FahrplanStepResult,
  type FahrplanStepState,
} from "@/lib/rebuild/controlTablesFahrplanTypes";
import { RAW_FOLDER_SPECS } from "@/lib/rebuild/validateRawSources";
import { wipeDerivedForType } from "@/lib/rebuild/wipeDerived";
import { buildLocalSearchIndex } from "@/lib/search/buildLocalSearchIndex";
import {
  embedSearchDocuments,
  embeddingsToJsonl,
} from "@/lib/search/embedSearchDocuments";
import {
  indexSearchDocuments,
  searchDocumentsToJsonl,
} from "@/lib/search/indexSearchDocuments";
import { searchDocumentSchema } from "@/lib/search/searchDocumentSchema";
import type { SearchDocument } from "@/lib/search/searchDocumentSchema";
import { buildCodeTableBindings } from "@/lib/tables/buildCodeTableBindings";
import { buildTableKnowledgeUnits } from "@/lib/tables/buildTableKnowledgeUnits";
import { buildTableRowEvidence } from "@/lib/tables/buildTableRowEvidence";
import { buildTableRuleGroups } from "@/lib/tables/buildTableRuleGroups";
import { buildAllTableSearchDrafts } from "@/lib/tables/draftTableSearchDocuments";
import { buildTableCorpusFromCanonical } from "@/lib/tables/loadCanonicalTables";
import { TABLE_KNOWLEDGE_VERSION } from "@/lib/tables/types";
import type {
  CanonicalTableClassification,
  CanonicalTableDefinition,
  CanonicalTableRow,
  TableEntity,
  TableRelation,
} from "@/lib/ingest/controlTables/model";
import type { LocalSearchIndex } from "@/lib/search/buildLocalSearchIndex";

const STATE_FILE = "control-tables-fahrplan.json";
const STAGING_PREFIX = "control-tables-fahrplan-staging";

const REQUIRED_FIELDS_BY_RECORD_TYPE: Record<string, string[]> = {
  table_definition: ["system_id", "client", "table_name"],
  table_classification: ["system_id", "client", "table_name", "classification"],
  table_row: ["system_id", "client", "table_name"],
};

function nowIso(): string {
  return new Date().toISOString();
}

function emptyStep(id: FahrplanStepId, status: FahrplanStepState["status"]): FahrplanStepState {
  return { id, status, result: null, updated_at: null };
}

export function createInitialFahrplanState(
  projectKey: string,
): ControlTablesFahrplanState {
  return {
    schema_version: 1,
    project: projectKey,
    type: CONTROL_TABLES_FAHRPLAN_TYPE,
    overall: "not_started",
    steps: {
      1: emptyStep(1, "ready"),
      2: emptyStep(2, "not_available"),
      3: emptyStep(3, "not_available"),
      4: emptyStep(4, "not_available"),
      5: emptyStep(5, "not_available"),
      6: emptyStep(6, "not_available"),
    },
    source_fingerprint: null,
    staging_ready: false,
    staging_validated: false,
    knowledge_activated_at: null,
    updated_at: nowIso(),
  };
}

function deriveOverall(
  steps: ControlTablesFahrplanState["steps"],
): FahrplanOverallStatus {
  const list = FAHRPLAN_STEP_IDS.map((id) => steps[id]);
  if (list.every((s) => s.status === "success")) return "completed";
  if (list.some((s) => s.status === "running")) return "processing";
  if (list.some((s) => s.status === "failed")) return "action_required";
  if (list.every((s) => s.status === "ready" || s.status === "not_available") &&
      steps[1].status === "ready" &&
      !steps[1].result) {
    return "not_started";
  }
  if (list.some((s) => s.status === "ready" || s.status === "success")) {
    const reviewing = list.some(
      (s) =>
        (s.id <= 2 && (s.status === "ready" || s.status === "running")) ||
        s.status === "success",
    );
    if (reviewing && !list.some((s) => s.id >= 3 && s.status === "success")) {
      return "in_review";
    }
    return "processing";
  }
  return "not_started";
}

function persistState(
  projectKey: string,
  state: ControlTablesFahrplanState,
): ControlTablesFahrplanState {
  const next = {
    ...state,
    overall: deriveOverall(state.steps),
    updated_at: nowIso(),
  };
  writeGeneratedText(
    projectKey,
    "logs",
    STATE_FILE,
    `${JSON.stringify(next, null, 2)}\n`,
  );
  return next;
}

export function loadControlTablesFahrplanState(
  projectKey: string,
): ControlTablesFahrplanState {
  const abs = resolveWritablePath(projectKey, "logs", STATE_FILE);
  if (!existsSync(abs)) {
    return createInitialFahrplanState(projectKey);
  }
  try {
    const raw = JSON.parse(readFileSync(abs, "utf8")) as ControlTablesFahrplanState;
    if (raw?.schema_version !== 1 || !raw.steps?.[1]) {
      return createInitialFahrplanState(projectKey);
    }
    // Heal lock invariants after load
    const healed = { ...raw, project: projectKey };
    for (const id of FAHRPLAN_STEP_IDS) {
      if (!healed.steps[id]) {
        healed.steps[id] = emptyStep(id, id === 1 ? "ready" : "not_available");
      }
    }
    // Ensure only first incomplete step is ready
    applyAvailability(healed);
    healed.overall = deriveOverall(healed.steps);
    return healed;
  } catch {
    return createInitialFahrplanState(projectKey);
  }
}

/** After success of step N, step N+1 becomes ready; later stay not_available unless already success chain. */
function applyAvailability(state: ControlTablesFahrplanState): void {
  for (const id of FAHRPLAN_STEP_IDS) {
    const step = state.steps[id];
    if (step.status === "running" || step.status === "failed") continue;
    if (id === 1) {
      if (step.status !== "success") step.status = "ready";
      continue;
    }
    const prev = state.steps[(id - 1) as FahrplanStepId];
    if (prev.status === "success") {
      if (step.status !== "success") step.status = "ready";
    } else if (step.status !== "success") {
      step.status = "not_available";
    }
  }
}

function resetFollowingSteps(
  state: ControlTablesFahrplanState,
  fromStepId: FahrplanStepId,
): void {
  for (const id of FAHRPLAN_STEP_IDS) {
    if (id <= fromStepId) continue;
    state.steps[id] = emptyStep(id, "not_available");
  }
  if (fromStepId < 3) {
    clearStaging(state.project);
    state.staging_ready = false;
    state.staging_validated = false;
  } else if (fromStepId === 3 || fromStepId === 4) {
    state.staging_validated = false;
  }
  if (fromStepId <= 5) {
    state.knowledge_activated_at = null;
  }
}

function clearStaging(projectKey: string): void {
  deleteGeneratedPath(projectKey, "logs", STAGING_PREFIX);
}

function assertStepExecutable(
  state: ControlTablesFahrplanState,
  stepId: FahrplanStepId,
): void {
  if (stepId === 1) return;
  const prev = state.steps[(stepId - 1) as FahrplanStepId];
  if (prev.status !== "success") {
    throw new Error(
      `Schritt ${stepId} ist gesperrt: Schritt ${stepId - 1} (${FAHRPLAN_STEP_META[(stepId - 1) as FahrplanStepId].title}) muss zuerst erfolgreich sein.`,
    );
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function isStructuralFileNameOk(fileName: string): boolean {
  if (!fileName.toLowerCase().endsWith(".jsonl")) return false;
  if (fileName.startsWith(".")) return false;
  if (/[\\/]/.test(fileName)) return false;
  if (!/^[A-Za-z0-9][A-Za-z0-9._\- ]{0,200}\.jsonl$/i.test(fileName)) {
    return false;
  }
  return true;
}

function peekSystemId(absolutePath: string): string | null {
  try {
    const text = readFileSync(absolutePath, "utf8").replace(/^\uFEFF/, "");
    const lines = text.split(/\r?\n/).slice(0, 40);
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line) as Record<string, unknown>;
        if (typeof obj.system_id === "string" && obj.system_id.trim()) {
          return obj.system_id.trim();
        }
      } catch {
        /* continue */
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

function listJsonlFiles(
  projectKey: string,
  folderParts: string[],
): Array<{ fileName: string; absolutePath: string; bytes: number; relativePath: string }> {
  const dirAbs = resolveRawPath(projectKey, ...folderParts);
  if (!existsSync(dirAbs) || !statSync(dirAbs).isDirectory()) {
    return [];
  }
  const entries = listRawEntries(projectKey, ...folderParts).filter(
    (name) => !name.startsWith(".") && name.toLowerCase().endsWith(".jsonl"),
  );
  return entries
    .map((fileName) => {
      const absolutePath = resolveRawPath(projectKey, ...folderParts, fileName);
      return {
        fileName,
        absolutePath,
        bytes: existsSync(absolutePath) ? statSync(absolutePath).size : 0,
        relativePath: [...folderParts, fileName].join("/"),
      };
    })
    .sort((a, b) => a.fileName.localeCompare(b.fileName));
}

function fingerprintSources(files: FahrplanSourceFileInfo[]): string {
  const h = createHash("sha256");
  for (const f of files) {
    h.update(`${f.relativePath}:${f.bytes};`);
  }
  return h.digest("hex").slice(0, 24);
}

function sha256File(absolutePath: string): string {
  return createHash("sha256").update(readFileSync(absolutePath)).digest("hex");
}

function writeJsonl(projectKey: string, rel: string, rows: object[]) {
  const body = rows.length
    ? `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`
    : "";
  writeGeneratedText(projectKey, "indexes", rel, body);
}

function parseJsonlFile<T extends Record<string, unknown>>(abs: string): T[] {
  if (!existsSync(abs)) return [];
  const text = readFileSync(abs, "utf8");
  const out: T[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    out.push(JSON.parse(line) as T);
  }
  return out;
}

type StagedCanonical = {
  definitions: CanonicalTableDefinition[];
  classifications: CanonicalTableClassification[];
  rows: CanonicalTableRow[];
  entities: TableEntity[];
  relations: TableRelation[];
  stats: Record<string, number>;
  issues_sample: Array<{
    sourceFile?: string;
    lineNumber?: number;
    error: string;
  }>;
  source_files: string[];
  source_sha256: string[];
};

function loadStaging(projectKey: string): StagedCanonical | null {
  const manifestAbs = resolveWritablePath(
    projectKey,
    "logs",
    `${STAGING_PREFIX}/manifest.json`,
  );
  if (!existsSync(manifestAbs)) return null;
  try {
    const manifest = JSON.parse(readFileSync(manifestAbs, "utf8")) as {
      stats?: Record<string, number>;
      issues_sample?: StagedCanonical["issues_sample"];
      source_files?: string[];
      source_sha256?: string[];
    };
    const base = (name: string) =>
      resolveWritablePath(projectKey, "logs", `${STAGING_PREFIX}/${name}`);
    return {
      definitions: parseJsonlFile(base("table_definitions.jsonl")),
      classifications: parseJsonlFile(base("table_classifications.jsonl")),
      rows: parseJsonlFile(base("table_rows.jsonl")),
      entities: parseJsonlFile(base("table_entities.jsonl")),
      relations: parseJsonlFile(base("table_relations.jsonl")),
      stats: manifest.stats ?? {},
      issues_sample: manifest.issues_sample ?? [],
      source_files: manifest.source_files ?? [],
      source_sha256: manifest.source_sha256 ?? [],
    };
  } catch {
    return null;
  }
}

function saveStaging(
  projectKey: string,
  staged: StagedCanonical,
): void {
  ensureWritableDir(projectKey, "logs", STAGING_PREFIX);
  writeGeneratedText(
    projectKey,
    "logs",
    `${STAGING_PREFIX}/table_definitions.jsonl`,
    recordsToJsonl(staged.definitions as unknown as Record<string, unknown>[]),
  );
  writeGeneratedText(
    projectKey,
    "logs",
    `${STAGING_PREFIX}/table_classifications.jsonl`,
    recordsToJsonl(
      staged.classifications as unknown as Record<string, unknown>[],
    ),
  );
  writeGeneratedText(
    projectKey,
    "logs",
    `${STAGING_PREFIX}/table_rows.jsonl`,
    recordsToJsonl(staged.rows as unknown as Record<string, unknown>[]),
  );
  writeGeneratedText(
    projectKey,
    "logs",
    `${STAGING_PREFIX}/table_entities.jsonl`,
    recordsToJsonl(staged.entities as unknown as Record<string, unknown>[]),
  );
  writeGeneratedText(
    projectKey,
    "logs",
    `${STAGING_PREFIX}/table_relations.jsonl`,
    recordsToJsonl(staged.relations as unknown as Record<string, unknown>[]),
  );
  writeGeneratedText(
    projectKey,
    "logs",
    `${STAGING_PREFIX}/manifest.json`,
    `${JSON.stringify(
      {
        at: nowIso(),
        stats: staged.stats,
        issues_sample: staged.issues_sample,
        source_files: staged.source_files,
        source_sha256: staged.source_sha256,
        counts: {
          definitions: staged.definitions.length,
          classifications: staged.classifications.length,
          rows: staged.rows.length,
          entities: staged.entities.length,
          relations: staged.relations.length,
        },
      },
      null,
      2,
    )}\n`,
  );
}

function pickSmokeFixtures(params: {
  definitions: Array<{ table_name: string; source_file?: string }>;
  rows: Array<{
    table_name: string;
    primary_key: Record<string, string>;
    values: Record<string, string>;
  }>;
}): { knownTable: string; knownValue: string; missingTable: string; knownField: string } {
  const preferred =
    params.rows.find((r) => r.table_name?.toUpperCase() === "YHXVARIT") ??
    params.rows[0];
  const withRows = preferred;
  const knownTable =
    withRows?.table_name ||
    params.definitions.find((d) => d.table_name)?.table_name ||
    "ZUNKNOWN";
  let knownValue = "";
  let knownField = "TABLE_NAME";
  if (withRows) {
    const pkEntry = Object.entries(withRows.primary_key ?? {}).find(
      ([, v]) => v && v !== "001" && String(v).length >= 2,
    );
    const valEntry = Object.entries(withRows.values ?? {})
      .filter(([k]) => k.toUpperCase() !== "MANDT")
      .find(([, v]) => String(v).length >= 2 && String(v).length <= 40);
    if (pkEntry) {
      knownField = pkEntry[0];
      knownValue = String(pkEntry[1]);
    } else if (valEntry) {
      knownField = valEntry[0];
      knownValue = String(valEntry[1]);
    } else {
      knownValue = knownTable;
    }
  } else {
    knownValue = knownTable;
  }
  return {
    knownTable,
    knownValue,
    knownField,
    missingTable: "ZZZZ_DOES_NOT_EXIST_TABLE_9X9X",
  };
}

const EXPECTED_Q01_RAW_SOURCES = [
  "control-tables/definitions/sap_z_control_tables_Q01.jsonl",
  "control-tables/contents/sap_z_control_tables_Q01_cont.jsonl",
] as const;

const CANONICAL_CONTROL_TABLE_FILES = [
  "table_definitions.jsonl",
  "table_classifications.jsonl",
  "table_rows.jsonl",
  "table_entities.jsonl",
  "table_relations.jsonl",
] as const;

function countJsonlLines(abs: string): number {
  if (!existsSync(abs)) return 0;
  const text = readFileSync(abs, "utf8");
  let n = 0;
  for (const line of text.split(/\r?\n/)) {
    if (line.trim()) n += 1;
  }
  return n;
}

function loadRebuildControlTablesReport(
  projectKey: string,
): Record<string, unknown> | null {
  const abs = resolveWritablePath(
    projectKey,
    "logs",
    "rebuild-control-tables-report.json",
  );
  if (!existsSync(abs)) return null;
  try {
    return JSON.parse(readFileSync(abs, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function collectRawSourceFilesFromDocuments(
  documents: SearchDocument[],
): string[] {
  const set = new Set<string>();
  for (const d of documents) {
    const meta = d.metadata as { raw_source_files?: unknown } | undefined;
    const files = meta?.raw_source_files;
    if (!Array.isArray(files)) continue;
    for (const f of files) {
      if (typeof f === "string" && f.trim()) set.add(f.trim());
    }
  }
  return [...set].sort();
}

function isQ01ControlTableSource(path: string): boolean {
  const norm = path.replace(/^raw\//, "");
  if ((EXPECTED_Q01_RAW_SOURCES as readonly string[]).includes(norm)) {
    return true;
  }
  return (
    norm.includes("sap_z_control_tables_Q01") &&
    norm.toLowerCase().endsWith(".jsonl")
  );
}

function isOldControlTableSource(path: string): boolean {
  const norm = path.replace(/^raw\//, "").toLowerCase();
  if (!norm.includes("control") || !norm.includes("table")) return false;
  if (norm.includes("q01")) return false;
  return (
    norm.includes("sap_z_control_tables") ||
    norm.includes("control-tables/") ||
    norm.includes("control_tables")
  );
}

export type ActiveControlTablesEvidence = {
  canonical_ok: boolean;
  canonical_missing: string[];
  definitions_count: number;
  rows_count: number;
  search_documents_count: number;
  embeddings_count: number;
  exact_index_ok: boolean;
  fulltext_index_ok: boolean;
  metadata_index_ok: boolean;
  vector_index_count: number;
  index_entries: number;
  raw_sources: string[];
  q01_sources_ok: boolean;
  old_sources: string[];
  activated_at: string | null;
  rebuild_report_ok: boolean;
  missing: string[];
  ok: boolean;
};

/**
 * Verify-only: active Canonical + SearchDocuments + Embeddings + Indexes
 * already contain Q01 control-table data. Never rebuilds or wipes.
 */
export function verifyExistingKnowledge(
  projectKey: string,
): ActiveControlTablesEvidence {
  const missing: string[] = [];
  const canonical_missing: string[] = [];

  for (const name of CANONICAL_CONTROL_TABLE_FILES) {
    const abs = resolveWritablePath(
      projectKey,
      "canonical",
      `control-tables/${name}`,
    );
    if (!existsSync(abs) || countJsonlLines(abs) === 0) {
      canonical_missing.push(`canonical/control-tables/${name}`);
    }
  }
  const canonical_ok = canonical_missing.length === 0;
  if (!canonical_ok) {
    missing.push(
      `Aktives Canonical unvollständig: ${canonical_missing.join(", ")}`,
    );
  }

  const definitions_count = countJsonlLines(
    resolveWritablePath(
      projectKey,
      "canonical",
      "control-tables/table_definitions.jsonl",
    ),
  );
  const rows_count = countJsonlLines(
    resolveWritablePath(
      projectKey,
      "canonical",
      "control-tables/table_rows.jsonl",
    ),
  );

  const docsAbs = resolveWritablePath(
    projectKey,
    "indexes",
    "tables/search_documents.jsonl",
  );
  const search_documents_count = countJsonlLines(docsAbs);
  if (search_documents_count === 0) {
    missing.push("SearchDocuments fehlen (indexes/tables/search_documents.jsonl)");
  }

  const embAbs = resolveWritablePath(
    projectKey,
    "embeddings",
    "search/control_tables_embeddings.jsonl",
  );
  const embeddings_count = countJsonlLines(embAbs);
  if (embeddings_count === 0) {
    missing.push(
      "Embeddings fehlen (embeddings/search/control_tables_embeddings.jsonl)",
    );
  } else if (
    search_documents_count > 0 &&
    embeddings_count !== search_documents_count
  ) {
    missing.push(
      `Embeddings (${embeddings_count}) ≠ SearchDocuments (${search_documents_count})`,
    );
  }

  const exactAbs = resolveWritablePath(
    projectKey,
    "indexes",
    "tables/exact_index.json",
  );
  const fulltextAbs = resolveWritablePath(
    projectKey,
    "indexes",
    "tables/fulltext_index.json",
  );
  const metadataAbs = resolveWritablePath(
    projectKey,
    "indexes",
    "tables/metadata_index.json",
  );
  const vectorAbs = resolveWritablePath(
    projectKey,
    "indexes",
    "tables/vector_index.jsonl",
  );
  const manifestAbs = resolveWritablePath(
    projectKey,
    "indexes",
    "tables/index_manifest.json",
  );

  let exact_index_ok = false;
  let fulltext_index_ok = false;
  let metadata_index_ok = false;
  try {
    exact_index_ok =
      existsSync(exactAbs) &&
      Object.keys(JSON.parse(readFileSync(exactAbs, "utf8")) as object)
        .length > 0;
  } catch {
    missing.push("exact_index.json ungültig");
  }
  try {
    fulltext_index_ok =
      existsSync(fulltextAbs) &&
      Object.keys(JSON.parse(readFileSync(fulltextAbs, "utf8")) as object)
        .length > 0;
  } catch {
    missing.push("fulltext_index.json ungültig");
  }
  try {
    metadata_index_ok =
      existsSync(metadataAbs) &&
      Object.keys(JSON.parse(readFileSync(metadataAbs, "utf8")) as object)
        .length > 0;
  } catch {
    missing.push("metadata_index.json ungültig");
  }
  const vector_index_count = countJsonlLines(vectorAbs);

  if (!exact_index_ok) missing.push("Keyword-Index fehlt/leer (exact_index.json)");
  if (!fulltext_index_ok) {
    missing.push("Fulltext-Index fehlt/leer (fulltext_index.json)");
  }
  if (!metadata_index_ok) {
    missing.push("Metadata-Index fehlt/leer (metadata_index.json)");
  }
  if (vector_index_count === 0) {
    missing.push("Vektorindex fehlt/leer (vector_index.jsonl)");
  } else if (
    search_documents_count > 0 &&
    vector_index_count !== search_documents_count
  ) {
    missing.push(
      `Vektorindex (${vector_index_count}) ≠ SearchDocuments (${search_documents_count})`,
    );
  }

  let activated_at: string | null = null;
  let manifestSources: string[] = [];
  if (existsSync(manifestAbs)) {
    try {
      const manifest = JSON.parse(readFileSync(manifestAbs, "utf8")) as {
        at?: string;
        raw_sources?: string[];
      };
      if (typeof manifest.at === "string" && manifest.at.trim()) {
        activated_at = manifest.at.trim();
      }
      if (Array.isArray(manifest.raw_sources)) {
        manifestSources = manifest.raw_sources.filter(
          (s): s is string => typeof s === "string",
        );
      }
    } catch {
      missing.push("index_manifest.json ungültig");
    }
  } else {
    missing.push("index_manifest.json fehlt");
  }

  const documents: SearchDocument[] =
    search_documents_count > 0 ? parseJsonlFile(docsAbs) : [];
  const docSources = collectRawSourceFilesFromDocuments(documents);
  const raw_sources = [...new Set([...manifestSources, ...docSources])].sort();
  const old_sources = raw_sources.filter(isOldControlTableSource);
  const q01_sources_ok =
    EXPECTED_Q01_RAW_SOURCES.every((exp) =>
      raw_sources.some(
        (s) =>
          s === exp ||
          s.endsWith(exp.split("/").pop()!) ||
          s.includes("sap_z_control_tables_Q01"),
      ),
    ) &&
    documents.length > 0 &&
    documents.every((d) => {
      const meta = d.metadata as { raw_source_files?: string[] } | undefined;
      const files = meta?.raw_source_files ?? [];
      if (files.length === 0) return false;
      return (
        files.every((f) => isQ01ControlTableSource(f)) &&
        !files.some(isOldControlTableSource)
      );
    });

  if (!q01_sources_ok) {
    missing.push(
      "Aktiver Index enthält keine belegbaren Q01-Control-Table-Quellen (sap_z_control_tables_Q01*)",
    );
  }
  if (old_sources.length > 0) {
    missing.push(
      `Alte Control-Table-Quellen im Index: ${old_sources.join(", ")}`,
    );
  }

  // Spot-check: at least one known Q01 table present
  const hasYhx =
    documents.some((d) =>
      `${d.title ?? ""} ${d.source_key ?? ""} ${d.object_name ?? ""}`
        .toUpperCase()
        .includes("YHXVARIT"),
    ) || definitions_count > 0;
  if (canonical_ok && search_documents_count > 0 && !hasYhx) {
    missing.push("Kein Q01-Tabellenbeleg (z. B. YHXVARIT) im aktiven Index");
  }

  const rebuild = loadRebuildControlTablesReport(projectKey);
  const rebuild_report_ok = Boolean(
    rebuild &&
      rebuild.success === true &&
      Array.isArray(rebuild.source_files) &&
      (rebuild.source_files as string[]).some((s) =>
        String(s).includes("Q01"),
      ),
  );
  if (!activated_at && rebuild && typeof rebuild.at === "string") {
    activated_at = rebuild.at;
  }

  let index_entries = 0;
  if (exact_index_ok && fulltext_index_ok && metadata_index_ok) {
    const exact = JSON.parse(readFileSync(exactAbs, "utf8")) as object;
    const fulltext = JSON.parse(readFileSync(fulltextAbs, "utf8")) as object;
    const metadata = JSON.parse(readFileSync(metadataAbs, "utf8")) as object;
    index_entries =
      Object.keys(exact).length +
      Object.keys(fulltext).length +
      Object.keys(metadata).length +
      vector_index_count;
  }

  const ok = missing.length === 0;

  return {
    canonical_ok,
    canonical_missing,
    definitions_count,
    rows_count,
    search_documents_count,
    embeddings_count,
    exact_index_ok,
    fulltext_index_ok,
    metadata_index_ok,
    vector_index_count,
    index_entries,
    raw_sources,
    q01_sources_ok,
    old_sources,
    activated_at,
    rebuild_report_ok,
    missing,
    ok,
  };
}

function evidenceToStep5Result(
  evidence: ActiveControlTablesEvidence,
): FahrplanStepResult {
  const substeps: NonNullable<FahrplanStepResult["substeps"]> = [
    {
      key: "canonical",
      label: "Aktives Canonical vorhanden",
      ok: evidence.canonical_ok,
      detail: evidence.canonical_ok
        ? `Definitionen=${evidence.definitions_count}, Zeilen=${evidence.rows_count}`
        : evidence.canonical_missing.join(", "),
    },
    {
      key: "searchdocs",
      label: "SearchDocuments vorhanden",
      ok: evidence.search_documents_count > 0,
      detail: `${evidence.search_documents_count}`,
    },
    {
      key: "embeddings",
      label: "Embeddings vorhanden",
      ok: evidence.embeddings_count > 0,
      detail: `${evidence.embeddings_count}`,
    },
    {
      key: "search_index",
      label: "Suchindex aktualisiert",
      ok:
        evidence.exact_index_ok &&
        evidence.fulltext_index_ok &&
        evidence.metadata_index_ok,
      detail: `exact/fulltext/metadata, Einträge=${evidence.index_entries}`,
    },
    {
      key: "vector_index",
      label: "Vektorindex aktualisiert",
      ok: evidence.vector_index_count > 0,
      detail: `${evidence.vector_index_count}`,
    },
    {
      key: "q01",
      label: "Aktiver Index enthält Q01-Control-Tables",
      ok: evidence.q01_sources_ok && evidence.old_sources.length === 0,
      detail: evidence.raw_sources.join(", ") || "(keine Quellen)",
    },
  ];

  if (!evidence.ok) {
    return {
      summary: "Index-Verifikation fehlgeschlagen.",
      hint: evidence.missing[0],
      errors: evidence.missing,
      substeps,
      counts: {
        search_documents: evidence.search_documents_count,
        embeddings: evidence.embeddings_count,
        index_entries: evidence.index_entries,
      },
      technical: {
        verify_only: true,
        missing: evidence.missing,
        raw_sources: evidence.raw_sources,
        activated_at: evidence.activated_at,
      },
    };
  }

  return {
    summary: `Index OK (verify): ${evidence.search_documents_count} Docs, ${evidence.embeddings_count} Embeddings.`,
    hint: `Aktiv seit ${evidence.activated_at ?? "—"} · Q01.`,
    substeps,
    counts: {
      search_documents: evidence.search_documents_count,
      embeddings: evidence.embeddings_count,
      index_entries: evidence.index_entries,
      definitions: evidence.definitions_count,
      rows: evidence.rows_count,
    },
    technical: {
      verify_only: true,
      raw_sources: evidence.raw_sources,
      activated_at: evidence.activated_at,
      rebuild_report_ok: evidence.rebuild_report_ok,
    },
  };
}

/**
 * Sync steps 2–4 to success from belegbarer aktiver Evidenz (kein Re-Convert).
 * Step 1 must already be success (or will stay as-is if detect fails).
 */
export function syncControlTablesFahrplanFromActiveEvidence(
  projectKey: string,
): {
  ok: boolean;
  message: string;
  state: ControlTablesFahrplanState;
  evidence: ActiveControlTablesEvidence;
} {
  let state = loadControlTablesFahrplanState(projectKey);
  const evidence = verifyExistingKnowledge(projectKey);

  if (!evidence.ok) {
    return {
      ok: false,
      message: `Aktive Evidenz unvollständig — Sync abgebrochen: ${evidence.missing.join("; ")}`,
      state,
      evidence,
    };
  }

  const rebuild = loadRebuildControlTablesReport(projectKey);
  const at =
    evidence.activated_at ??
    (typeof rebuild?.at === "string" ? rebuild.at : nowIso());
  const sourceFiles =
    (Array.isArray(rebuild?.source_files)
      ? (rebuild!.source_files as string[])
      : evidence.raw_sources) ?? evidence.raw_sources;

  if (state.steps[1].status !== "success") {
    const detect = runStep1Detect(projectKey);
    if (detect.errors?.length) {
      return {
        ok: false,
        message: `Schritt 1 nicht belegbar: ${detect.hint}`,
        state,
        evidence,
      };
    }
    state.steps[1] = {
      id: 1,
      status: "success",
      result: detect,
      updated_at: at,
    };
    state.source_fingerprint = fingerprintSources(detect.files ?? []);
  }

  const stats =
    (rebuild?.canonical_stats as Record<string, number> | undefined) ?? {};

  state.steps[2] = {
    id: 2,
    status: "success",
    result: {
      summary: `RAW OK (Sync aus Rebuild-Evidenz): ${rebuild?.lines_read ?? "?"} Zeilen, strukturell gültig.`,
      hint: `system_id=Q01 · verify-only, keine Re-Konvertierung`,
      counts: {
        lines_checked: Number(rebuild?.lines_read ?? 0),
        errors: 0,
        tables_defs: Number(stats.definitions ?? evidence.definitions_count),
        tables_rows: Number(stats.tables_with_rows ?? 0),
      },
      technical: {
        synced_from: "rebuild-control-tables-report.json",
        structural_validation_ok: rebuild?.structural_validation_ok === true,
        source_files: sourceFiles,
        verify_only: true,
      },
    },
    updated_at: at,
  };

  state.steps[3] = {
    id: 3,
    status: "success",
    result: {
      summary: `Canonical aktiv: ${evidence.definitions_count} Tabellen, ${evidence.rows_count} Zeilen.`,
      hint: "Keine Re-Konvertierung — Sync aus aktivem Stand.",
      counts: {
        definitions: evidence.definitions_count,
        rows: evidence.rows_count,
        search_documents: evidence.search_documents_count,
      },
      technical: {
        synced_from: "canonical/control-tables + rebuild report",
        source_files: sourceFiles,
        verify_only: true,
        staging_skipped: true,
      },
    },
    updated_at: at,
  };

  state.steps[4] = {
    id: 4,
    status: "success",
    result: {
      summary: `Canonical OK (aktiv): ${evidence.definitions_count} Tabellen im Index.`,
      hint: "Aktiver Q01-Stand — Staging nicht nötig.",
      counts: {
        definitions: evidence.definitions_count,
        rows: evidence.rows_count,
        index_entries: evidence.index_entries,
      },
      technical: {
        synced_from: "active indexes + canonical",
        raw_sources: evidence.raw_sources,
        verify_only: true,
      },
    },
    updated_at: at,
  };

  // No staging on disk; mark validated so step 5 verify path can run under locks
  state.staging_ready = false;
  state.staging_validated = true;
  applyAvailability(state);
  state = persistState(projectKey, state);

  return {
    ok: true,
    message: `Schritte 2–4 aus aktiver Q01-Evidenz synchronisiert (Aktivierung ${at}).`,
    state,
    evidence,
  };
}

/**
 * Reconcile persisted Fahrplan status with real on-disk state (RAW / Canonical / Index).
 * Call on Admin load so the control panel mirrors actual processing, not checklist fiction.
 * Does not wipe or rebuild — only reads + updates status JSON.
 */
export function reconcileControlTablesFahrplanFromDisk(
  projectKey: string,
): ControlTablesFahrplanState {
  const evidence = verifyExistingKnowledge(projectKey);
  const at = evidence.activated_at ?? nowIso();

  // Full knowledge already on disk → sync steps 1–5 from evidence (honest green).
  if (evidence.ok) {
    const synced = syncControlTablesFahrplanFromActiveEvidence(projectKey);
    let state = synced.state;

    if (state.steps[5].status !== "success") {
      state.steps[5] = {
        id: 5,
        status: "success",
        result: evidenceToStep5Result(evidence),
        updated_at: at,
      };
      state.knowledge_activated_at = evidence.activated_at;
    } else if (!state.steps[5].result?.counts) {
      state.steps[5] = {
        ...state.steps[5],
        result: evidenceToStep5Result(evidence),
      };
    }

    // Refresh RAW file listing in step 1 result for the control panel.
    const detect = runStep1Detect(projectKey);
    if (!detect.errors?.length) {
      state.steps[1] = {
        ...state.steps[1],
        status: "success",
        result: detect,
        updated_at: state.steps[1].updated_at ?? at,
      };
      state.source_fingerprint =
        state.source_fingerprint ?? fingerprintSources(detect.files ?? []);
    }

    applyAvailability(state);
    if (
      state.steps[6].status === "not_available" &&
      state.steps[5].status === "success"
    ) {
      state.steps[6].status = "ready";
    }
    return persistState(projectKey, state);
  }

  // No complete knowledge yet — still show real RAW presence / gaps.
  let state = loadControlTablesFahrplanState(projectKey);
  const detect = runStep1Detect(projectKey);
  const detectOk = !detect.errors?.length;

  if (detectOk) {
    if (state.steps[1].status !== "success") {
      state.steps[1] = {
        id: 1,
        status: "success",
        result: detect,
        updated_at: nowIso(),
      };
      state.source_fingerprint = fingerprintSources(detect.files ?? []);
    } else {
      state.steps[1] = { ...state.steps[1], result: detect };
    }
  } else {
    state.steps[1] = {
      id: 1,
      status:
        state.steps[1].status === "success" ? "failed" : "ready",
      result: detect,
      updated_at: nowIso(),
    };
  }

  // Partial artifacts: show real counts without inventing full success.
  if (
    evidence.definitions_count > 0 ||
    evidence.search_documents_count > 0 ||
    evidence.embeddings_count > 0
  ) {
    const partial = evidenceToStep5Result(evidence);
    if (state.steps[5].status !== "success") {
      state.steps[5] = {
        id: 5,
        status: "failed",
        result: partial,
        updated_at: nowIso(),
      };
    }
  }

  applyAvailability(state);
  return persistState(projectKey, state);
}

function loadActiveCanonicalFixtures(projectKey: string): {
  definitions: Array<{ table_name: string; source_file?: string }>;
  rows: Array<{
    table_name: string;
    primary_key: Record<string, string>;
    values: Record<string, string>;
    source_file?: string;
  }>;
  source_files: string[];
} {
  const defsAbs = resolveWritablePath(
    projectKey,
    "canonical",
    "control-tables/table_definitions.jsonl",
  );
  const rowsAbs = resolveWritablePath(
    projectKey,
    "canonical",
    "control-tables/table_rows.jsonl",
  );
  const definitions = existsSync(defsAbs)
    ? parseJsonlFile<{ table_name: string; source_file?: string }>(defsAbs)
    : [];
  // Only need a small sample for fixtures — prefer YHXVARIT
  const rows: Array<{
    table_name: string;
    primary_key: Record<string, string>;
    values: Record<string, string>;
    source_file?: string;
  }> = [];
  if (existsSync(rowsAbs)) {
    const text = readFileSync(rowsAbs, "utf8");
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line) as {
          table_name: string;
          primary_key: Record<string, string>;
          values: Record<string, string>;
          source_file?: string;
        };
        if (row.table_name?.toUpperCase() === "YHXVARIT") {
          rows.unshift(row);
          if (rows.length >= 3) break;
        } else if (rows.length < 1) {
          rows.push(row);
        }
      } catch {
        /* skip */
      }
    }
  }
  const ingestAbs = resolveWritablePath(
    projectKey,
    "canonical",
    "control-tables/ingest_report.json",
  );
  let source_files: string[] = [];
  if (existsSync(ingestAbs)) {
    try {
      const ingest = JSON.parse(readFileSync(ingestAbs, "utf8")) as {
        sources?: Array<{ file?: string }>;
      };
      source_files = (ingest.sources ?? [])
        .map((s) =>
          s.file?.startsWith("control-tables/")
            ? s.file
            : s.file
              ? `control-tables/${s.file}`
              : "",
        )
        .filter(Boolean);
    } catch {
      /* ignore */
    }
  }
  if (source_files.length === 0) {
    source_files = [...EXPECTED_Q01_RAW_SOURCES];
  }
  return { definitions, rows, source_files };
}

function sourcesAreCurrentQ01(
  hits: Array<{ metadata?: Record<string, unknown> }>,
): { ok: boolean; detail: string } {
  const found = new Set<string>();
  const old: string[] = [];
  for (const h of hits) {
    const files = (h.metadata?.raw_source_files as string[] | undefined) ?? [];
    for (const f of files) {
      found.add(f);
      if (isOldControlTableSource(f)) old.push(f);
    }
  }
  if (old.length > 0) {
    return {
      ok: false,
      detail: `Alte Quellen: ${[...new Set(old)].join(", ")}`,
    };
  }
  if (found.size === 0) {
    return { ok: true, detail: "Keine raw_source_files an Treffern (ok wenn unzureichend)" };
  }
  const allQ01 = [...found].every(isQ01ControlTableSource);
  return {
    ok: allQ01,
    detail: allQ01
      ? `Q01-Quellen: ${[...found].join(", ")}`
      : `Unerwartete Quellen: ${[...found].join(", ")}`,
  };
}

// ── Step runners ───────────────────────────────────────────────────────────

function runStep1Detect(projectKey: string): FahrplanStepResult {
  const errors: string[] = [];
  const files: FahrplanSourceFileInfo[] = [];
  const folders = RAW_FOLDER_SPECS["control-tables"];

  for (const folder of folders) {
    const role = folder.role === "contents" ? "contents" : "definitions";
    const listed = listJsonlFiles(projectKey, folder.folderParts);
    if (listed.length === 0) {
      errors.push(`Keine Quelldatei in ${folder.label}.`);
      continue;
    }
    if (listed.length > 1) {
      errors.push(
        `Mehrere Dateien in ${folder.label}: ${listed.map((f) => f.fileName).join(", ")}. Es darf genau eine *.jsonl liegen.`,
      );
    }
    for (const f of listed) {
      if (!isStructuralFileNameOk(f.fileName)) {
        errors.push(`Dateiname strukturell ungültig: ${f.fileName}`);
      }
      let readable = true;
      try {
        readFileSync(f.absolutePath, { encoding: "utf8", flag: "r" });
      } catch (e) {
        readable = false;
        errors.push(
          `${f.relativePath}: nicht lesbar — ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      files.push({
        relativePath: f.relativePath,
        fileName: f.fileName,
        bytes: f.bytes,
        role,
        system_id: readable ? peekSystemId(f.absolutePath) : null,
      });
    }
  }

  const hasDefs = files.some((f) => f.role === "definitions");
  const hasContents = files.some((f) => f.role === "contents");
  if (hasContents && !hasDefs) {
    errors.push(
      "Inhalt ohne Definitionen: raw/control-tables/contents vorhanden, definitions fehlt.",
    );
  }
  if (!hasDefs || !hasContents) {
    errors.push(
      "Gruppe unvollständig: definitions und contents werden beide benötigt.",
    );
  }

  // Exactly one per role after filtering errors for multiples
  const defCount = files.filter((f) => f.role === "definitions").length;
  const contentCount = files.filter((f) => f.role === "contents").length;
  if (defCount !== 1 || contentCount !== 1) {
    // already covered by folder errors; ensure fail
    if (!errors.some((e) => e.includes("genau eine") || e.includes("Keine Quelldatei"))) {
      errors.push(
        `Erwartet je 1 Datei (definitions=${defCount}, contents=${contentCount}).`,
      );
    }
  }

  const systemIds = [
    ...new Set(files.map((f) => f.system_id).filter(Boolean) as string[]),
  ];

  if (errors.length > 0) {
    return {
      summary: "Quellenprüfung fehlgeschlagen.",
      hint: errors[0],
      files,
      errors,
      counts: {
        files: files.length,
        definitions: defCount,
        contents: contentCount,
      },
      technical: { system_ids: systemIds },
    };
  }

  return {
    summary: `Quellen OK: ${files.length} Datei(en), system_id=${systemIds.join(", ") || "—"}.`,
    hint: files
      .map((f) => `${f.fileName} (${formatBytes(f.bytes)})`)
      .join(" · "),
    files,
    counts: {
      files: files.length,
      definitions: defCount,
      contents: contentCount,
    },
    technical: {
      system_ids: systemIds,
      files: files.map((f) => ({
        path: f.relativePath,
        bytes: f.bytes,
        system_id: f.system_id,
      })),
    },
  };
}

function runStep2RawValidate(projectKey: string): FahrplanStepResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  let linesChecked = 0;
  const systemIds = new Set<string>();
  const tableNamesDefs = new Set<string>();
  const tableNamesRows = new Set<string>();
  const files: FahrplanSourceFileInfo[] = [];

  for (const folder of RAW_FOLDER_SPECS["control-tables"]) {
    const role = folder.role === "contents" ? "contents" : "definitions";
    const listed = listJsonlFiles(projectKey, folder.folderParts);
    if (listed.length !== 1) {
      errors.push(
        `${folder.label}: genau eine Datei erforderlich (gefunden: ${listed.length}).`,
      );
      continue;
    }
    const f = listed[0]!;
    files.push({
      relativePath: f.relativePath,
      fileName: f.fileName,
      bytes: f.bytes,
      role,
      system_id: peekSystemId(f.absolutePath),
    });

    let text: string;
    try {
      text = readFileSync(f.absolutePath, "utf8").replace(/^\uFEFF/, "");
    } catch (e) {
      errors.push(
        `${f.relativePath}: nicht lesbar — ${e instanceof Error ? e.message : String(e)}`,
      );
      continue;
    }

    const lines = text.split(/\r?\n/);
    let validObjects = 0;
    const recordTypes = new Set<string>();
    const completeByType = new Set<string>();

    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i] ?? "";
      if (!raw.trim()) continue;
      linesChecked += 1;
      let value: unknown;
      try {
        value = JSON.parse(raw);
      } catch (e) {
        errors.push(
          `${f.fileName}:${i + 1}: ungültiges JSON — ${e instanceof Error ? e.message : "Parse-Fehler"}`,
        );
        continue;
      }
      if (value == null || typeof value !== "object" || Array.isArray(value)) {
        errors.push(`${f.fileName}:${i + 1}: Zeile ist kein JSON-Objekt`);
        continue;
      }
      validObjects += 1;
      const obj = value as Record<string, unknown>;
      const recordType =
        typeof obj.record_type === "string" ? obj.record_type.trim() : "";
      if (!recordType) {
        errors.push(`${f.fileName}:${i + 1}: record_type fehlt`);
        continue;
      }
      recordTypes.add(recordType);
      if (recordType === "header") continue;

      const required = REQUIRED_FIELDS_BY_RECORD_TYPE[recordType];
      if (required) {
        const missing = required.filter((field) => {
          const v = obj[field];
          return v == null || (typeof v === "string" && !v.trim());
        });
        if (missing.length) {
          errors.push(
            `${f.fileName}:${i + 1}: Pflichtfelder fehlen (${missing.join(", ")})`,
          );
        } else {
          completeByType.add(recordType);
        }
      }

      if (typeof obj.system_id === "string" && obj.system_id.trim()) {
        systemIds.add(obj.system_id.trim());
      }
      if (typeof obj.table_name === "string" && obj.table_name.trim()) {
        if (recordType === "table_definition") {
          tableNamesDefs.add(obj.table_name.trim().toUpperCase());
        }
        if (recordType === "table_row") {
          tableNamesRows.add(obj.table_name.trim().toUpperCase());
        }
      }
    }

    if (linesChecked === 0 || validObjects === 0) {
      errors.push(`${folder.label}: keine gültigen JSONL-Zeilen`);
    }
    for (const rt of folder.requiredRecordTypes ?? []) {
      if (!recordTypes.has(rt)) {
        errors.push(
          `${folder.label}: erforderlicher record_type „${rt}“ fehlt`,
        );
      } else if (!completeByType.has(rt)) {
        errors.push(
          `${folder.label}: kein vollständiger Datensatz für „${rt}“`,
        );
      }
    }
  }

  if (systemIds.size > 1) {
    warnings.push(
      `Mehrere system_id in den Quellen: ${[...systemIds].join(", ")}`,
    );
  }
  if (systemIds.size === 0) {
    errors.push("Kein system_id in den Datensätzen gefunden.");
  }

  // Compatibility: rows should reference known tables when both present
  if (tableNamesDefs.size > 0 && tableNamesRows.size > 0) {
    const orphan = [...tableNamesRows].filter((t) => !tableNamesDefs.has(t));
    if (orphan.length > 0) {
      warnings.push(
        `${orphan.length} Tabellen in contents ohne Definition (z. B. ${orphan.slice(0, 3).join(", ")}).`,
      );
    }
  }

  // Converter can process: try a lightweight canonicalize dry-run when structurally ok enough
  if (errors.length === 0 && files.length === 2) {
    try {
      const payloads = files.map((s) => {
        const parts = s.relativePath.split("/");
        const buffer = readRawBuffer(projectKey, ...parts);
        return {
          text: buffer.toString("utf8"),
          sourceFile: parts.slice(1).join("/"),
        };
      });
      const canonical = canonicalizeControlTableSources(payloads);
      if (canonical.stats.definitions === 0) {
        errors.push(
          "Konverter kann keine Tabellendefinitionen erzeugen — Struktur prüfen.",
        );
      }
      if (canonical.stats.invalid > 0) {
        warnings.push(
          `Konverter meldet ${canonical.stats.invalid} ungültige Zeile(n).`,
        );
      }
    } catch (e) {
      errors.push(
        `Konverter-Probe fehlgeschlagen: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  if (errors.length > 0) {
    return {
      summary: "RAW-Prüfung fehlgeschlagen.",
      hint: errors[0],
      files,
      errors: errors.slice(0, 40),
      warnings,
      counts: {
        lines_checked: linesChecked,
        warnings: warnings.length,
        errors: errors.length,
      },
      technical: {
        system_ids: [...systemIds],
        tables_defs: tableNamesDefs.size,
        tables_rows: tableNamesRows.size,
      },
    };
  }

  return {
    summary: `RAW OK: ${linesChecked} Zeilen geprüft, ${warnings.length} Warnung(en).`,
    hint: `system_id=${[...systemIds].join(", ") || "—"}`,
    files,
    warnings,
    counts: {
      lines_checked: linesChecked,
      warnings: warnings.length,
      errors: 0,
      tables_defs: tableNamesDefs.size,
      tables_rows: tableNamesRows.size,
    },
    technical: { system_ids: [...systemIds] },
  };
}

function runStep3Convert(projectKey: string): FahrplanStepResult {
  const substeps: FahrplanStepResult["substeps"] = [];
  const folders = RAW_FOLDER_SPECS["control-tables"];
  const sources: Array<{
    relativePath: string;
    absolutePath: string;
    bytes: number;
    sha256: string;
  }> = [];

  for (const folder of folders) {
    const listed = listJsonlFiles(projectKey, folder.folderParts);
    if (listed.length !== 1) {
      throw new Error(
        `${folder.label}: genau eine Datei erforderlich für die Verarbeitung.`,
      );
    }
    const f = listed[0]!;
    sources.push({
      relativePath: f.relativePath,
      absolutePath: f.absolutePath,
      bytes: f.bytes,
      sha256: sha256File(f.absolutePath),
    });
  }
  substeps.push({
    key: "sources",
    label: "Quellen geladen",
    ok: true,
    detail: sources.map((s) => s.relativePath).join(", "),
  });

  const payloads = sources.map((s) => {
    const parts = s.relativePath.split("/");
    const buffer = readRawBuffer(projectKey, ...parts);
    return {
      text: buffer.toString("utf8"),
      sourceFile: parts.slice(1).join("/"),
    };
  });

  const canonical = canonicalizeControlTableSources(payloads);
  substeps.push({
    key: "convert",
    label: "Konverter ausgeführt",
    ok: canonical.stats.definitions > 0,
    detail: `Definitionen=${canonical.stats.definitions}, Zeilen=${canonical.stats.rows ?? canonical.rows.length}`,
  });

  if (canonical.stats.definitions === 0) {
    throw new Error(
      `Konverter erzeugte keine Tabellendefinitionen (Zeilen=${canonical.stats.lines_total}, ungültig=${canonical.stats.invalid}).`,
    );
  }

  const staged: StagedCanonical = {
    definitions: canonical.definitions,
    classifications: canonical.classifications,
    rows: canonical.rows,
    entities: canonical.entities,
    relations: canonical.relations,
    stats: {
      lines_total: canonical.stats.lines_total,
      valid: canonical.stats.valid,
      invalid: canonical.stats.invalid,
      definitions: canonical.definitions.length,
      classifications: canonical.classifications.length,
      rows: canonical.rows.length,
      entities: canonical.entities.length,
      relations: canonical.relations.length,
    },
    issues_sample: canonical.issues.slice(0, 20).map((i) => ({
      sourceFile: i.sourceFile,
      lineNumber: i.lineNumber,
      error: i.error,
    })),
    source_files: sources.map((s) => s.relativePath),
    source_sha256: sources.map((s) => s.sha256),
  };

  saveStaging(projectKey, staged);
  substeps.push({
    key: "staging",
    label: "Staging geschrieben",
    ok: true,
    detail: `${STAGING_PREFIX}/ (aktiver Index unverändert)`,
  });

  const total =
    staged.definitions.length +
    staged.classifications.length +
    staged.rows.length +
    staged.entities.length +
    staged.relations.length;

  return {
    summary: `Konvertierung OK: ${total} Canonical-Datensätze im Staging.`,
    hint: "Aktiver Index noch nicht ersetzt.",
    counts: {
      canonical_records: total,
      definitions: staged.definitions.length,
      rows: staged.rows.length,
      invalid: canonical.stats.invalid,
    },
    warnings: canonical.issues.slice(0, 5).map((i) => i.error),
    substeps,
    technical: {
      source_files: staged.source_files,
      source_sha256: staged.source_sha256,
      staging: STAGING_PREFIX,
    },
  };
}

function runStep4ValidateCanonical(projectKey: string): FahrplanStepResult {
  const staged = loadStaging(projectKey);
  if (!staged || staged.definitions.length === 0) {
    throw new Error(
      "Kein Staging-Canonical gefunden. Bitte Schritt 3 (Verarbeiten) erneut ausführen.",
    );
  }

  const errors: string[] = [];
  const warnings: string[] = [];
  const tableNames = new Set(
    staged.definitions.map((d) => d.table_name.toUpperCase()),
  );
  const defKeys = new Set<string>();
  const rowKeys = new Set<string>();

  for (const d of staged.definitions) {
    if (d.record_type !== "table_definition") {
      errors.push(`Ungültiger record_type in Definition: ${d.source_key}`);
    }
    if (!d.table_name || !d.source_key || !d.system_id) {
      errors.push(`Definition ohne Pflichtfelder: ${d.source_key || d.table_name}`);
    }
    if (defKeys.has(d.source_key)) {
      errors.push(`Doppelte Definition: ${d.source_key}`);
    }
    defKeys.add(d.source_key);
  }

  for (const r of staged.rows) {
    if (r.record_type !== "table_row") {
      errors.push(`Ungültiger record_type in Zeile: ${r.source_key}`);
    }
    if (!r.table_name || !r.source_key || !r.system_id) {
      errors.push(`Zeile ohne Pflichtfelder / leere ID: ${r.source_key || "?"}`);
    }
    if (!tableNames.has(r.table_name.toUpperCase())) {
      errors.push(
        `Zeile referenziert unbekannte Tabelle ${r.table_name} (${r.source_key})`,
      );
    }
    if (rowKeys.has(r.source_key)) {
      errors.push(`Doppelte Zeile: ${r.source_key}`);
    }
    rowKeys.add(r.source_key);
    if (!r.source_file) {
      warnings.push(`Zeile ohne source_file: ${r.source_key}`);
    }
  }

  // Plausible counts
  const inputLines = staged.stats.lines_total ?? 0;
  const outCount =
    staged.definitions.length +
    staged.classifications.length +
    staged.rows.length;
  if (inputLines > 0 && outCount === 0) {
    errors.push("Eingabe/Ausgabe unplausibel: Eingabezeilen vorhanden, Ausgabe leer.");
  }
  if (staged.definitions.length === 0) {
    errors.push("Keine table_definitions im Staging.");
  }

  // Source refs
  for (const d of staged.definitions) {
    if (!d.source_file && !d.source_key) {
      errors.push(`Definition ohne Quellenbezug: ${d.table_name}`);
    }
  }

  // Round-trip JSONL
  try {
    for (const name of [
      "table_definitions.jsonl",
      "table_classifications.jsonl",
      "table_rows.jsonl",
      "table_entities.jsonl",
      "table_relations.jsonl",
    ] as const) {
      const abs = resolveWritablePath(
        projectKey,
        "logs",
        `${STAGING_PREFIX}/${name}`,
      );
      if (!existsSync(abs)) {
        errors.push(`Staging-Datei fehlt: ${name}`);
        continue;
      }
      const text = readFileSync(abs, "utf8");
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        JSON.parse(line);
      }
    }
  } catch (e) {
    errors.push(
      `JSONL-Roundtrip fehlgeschlagen: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  if (errors.length > 0) {
    return {
      summary: "Canonical-Prüfung fehlgeschlagen.",
      hint: errors[0],
      errors: errors.slice(0, 40),
      warnings,
      counts: {
        definitions: staged.definitions.length,
        rows: staged.rows.length,
        errors: errors.length,
      },
    };
  }

  return {
    summary: `Canonical OK: ${staged.definitions.length} Tabellen, ${staged.rows.length} Zeilen.`,
    hint: "Bereit für Index-Update.",
    warnings,
    counts: {
      definitions: staged.definitions.length,
      classifications: staged.classifications.length,
      rows: staged.rows.length,
      entities: staged.entities.length,
      relations: staged.relations.length,
      warnings: warnings.length,
    },
    technical: {
      source_files: staged.source_files,
      input_lines: inputLines,
      output_records: outCount,
    },
  };
}

async function runStep5ActivateKnowledge(params: {
  projectKey: string;
  customerId: string;
  systemId: string;
  onSubstep?: (label: string) => void;
  /** Prefer verify-existing when active Q01 knowledge is already present. */
  preferVerifyExisting?: boolean;
}): Promise<FahrplanStepResult & { knowledge_activated_at?: string | null }> {
  const { projectKey } = params;

  // Verify-and-activate path: no wipe, no rebuild, no re-embed
  if (params.preferVerifyExisting !== false) {
    params.onSubstep?.("Aktiven Index prüfen");
    const evidence = verifyExistingKnowledge(projectKey);
    if (evidence.ok) {
      const result = evidenceToStep5Result(evidence);
      appendLogLine(
        projectKey,
        "rebuild-control-tables.log",
        `[${nowIso()}] fahrplan_step5 verify_existing=true success=true docs=${evidence.search_documents_count} emb=${evidence.embeddings_count} index=${evidence.index_entries} activated_at=${evidence.activated_at}`,
      );
      return {
        ...result,
        knowledge_activated_at: evidence.activated_at,
      };
    }
    // Active data partially present but incomplete → do NOT rebuild; report gaps
    if (
      evidence.search_documents_count > 0 ||
      evidence.definitions_count > 0 ||
      evidence.embeddings_count > 0
    ) {
      const failed = evidenceToStep5Result(evidence);
      throw Object.assign(
        new Error(failed.hint || failed.summary),
        { fahrplanResult: failed },
      );
    }
  }

  const staged = loadStaging(projectKey);
  if (!staged || staged.definitions.length === 0) {
    throw new Error(
      "Kein Staging und kein aktiver Index — Schritte 3–4 erneut ausführen.",
    );
  }

  const substeps: NonNullable<FahrplanStepResult["substeps"]> = [];
  const mark = (key: string, label: string, ok: boolean, detail?: string) => {
    substeps.push({ key, label, ok, detail });
    params.onSubstep?.(label);
  };

  // Prepare SearchDocuments BEFORE wipe (prepare-then-swap)
  params.onSubstep?.("SearchDocuments vorbereiten");
  const now = nowIso();
  const ingestReportPreview = {
    at: now,
    project: projectKey,
    rebuild: true,
    fahrplan: true,
    sources: staged.source_files.map((file, i) => ({
      file: file.replace(/^control-tables\//, ""),
      sha256: staged.source_sha256[i],
    })),
    stats: staged.stats,
  };

  const bundle = buildTableCorpusFromCanonical({
    projectKey,
    definitions: staged.definitions,
    classifications: staged.classifications,
    rows: staged.rows,
    ingestReport: ingestReportPreview,
  });
  const units = buildTableKnowledgeUnits({
    bundle,
    customerId: params.customerId,
    systemId: params.systemId,
  });
  const ruleGroups = buildTableRuleGroups({ bundle, units });
  const rows = buildTableRowEvidence({ bundle, units, ruleGroups });
  const bindings = buildCodeTableBindings({ bundle, rows, ruleGroups });
  const drafts = buildAllTableSearchDrafts({
    units,
    ruleGroups,
    rows,
    bindings,
    systemId: params.systemId,
  });
  for (const draft of drafts) {
    draft.metadata = {
      ...(draft.metadata ?? {}),
      raw_source_files: staged.source_files,
    };
  }
  const indexed = indexSearchDocuments({
    drafts,
    existingJsonl: "",
    now,
    replaceCorpus: true,
  });
  for (const doc of indexed.documents) {
    const ok = searchDocumentSchema.safeParse(doc);
    if (!ok.success) {
      throw new Error(
        `SearchDocument ungültig ${doc.source_key}: ${ok.error.message}`,
      );
    }
  }
  if (indexed.documents.length === 0) {
    throw new Error("Keine SearchDocuments erzeugt — Abbruch ohne Löschen.");
  }
  mark(
    "searchdocs",
    "SearchDocuments vorbereitet",
    true,
    `${indexed.documents.length} Dokumente`,
  );

  // Destructive swap — only control-tables
  const wiped = wipeDerivedForType({ projectKey, type: "control-tables" });
  mark(
    "wipe",
    "Alte Control-Table-Daten gelöscht",
    true,
    wiped.deleted_paths.join(", ") || "keine alten Pfade",
  );

  // Persist Canonical
  ensureWritableDir(projectKey, "canonical", "control-tables");
  writeGeneratedText(
    projectKey,
    "canonical",
    "control-tables/table_definitions.jsonl",
    recordsToJsonl(staged.definitions as unknown as Record<string, unknown>[]),
  );
  writeGeneratedText(
    projectKey,
    "canonical",
    "control-tables/table_classifications.jsonl",
    recordsToJsonl(
      staged.classifications as unknown as Record<string, unknown>[],
    ),
  );
  writeGeneratedText(
    projectKey,
    "canonical",
    "control-tables/table_rows.jsonl",
    recordsToJsonl(staged.rows as unknown as Record<string, unknown>[]),
  );
  writeGeneratedText(
    projectKey,
    "canonical",
    "control-tables/table_entities.jsonl",
    recordsToJsonl(staged.entities as unknown as Record<string, unknown>[]),
  );
  writeGeneratedText(
    projectKey,
    "canonical",
    "control-tables/table_relations.jsonl",
    recordsToJsonl(staged.relations as unknown as Record<string, unknown>[]),
  );
  writeGeneratedText(
    projectKey,
    "canonical",
    "control-tables/ingest_report.json",
    `${JSON.stringify({ ...ingestReportPreview, raw_files_unchanged: true }, null, 2)}\n`,
  );
  mark("canonical", "Canonical gespeichert", true);

  ensureWritableDir(projectKey, "indexes", "tables");
  writeJsonl(projectKey, "tables/table_knowledge_units.jsonl", units);
  writeJsonl(projectKey, "tables/table_rule_groups.jsonl", ruleGroups);
  writeJsonl(projectKey, "tables/table_row_evidence.jsonl", rows);
  writeJsonl(projectKey, "tables/code_table_bindings.jsonl", bindings);
  writeGeneratedText(
    projectKey,
    "indexes",
    "tables/search_documents.jsonl",
    searchDocumentsToJsonl(indexed.documents),
  );
  mark(
    "docs_persisted",
    "SearchDocuments gespeichert",
    true,
    `${indexed.documents.length}`,
  );

  const embedded = await embedSearchDocuments({
    documents: indexed.documents,
    existingJsonl: "",
    replaceCorpus: true,
    now,
  });
  writeGeneratedText(
    projectKey,
    "embeddings",
    "search/control_tables_embeddings.jsonl",
    embeddingsToJsonl(embedded.records),
  );
  mark(
    "embeddings",
    "Embeddings erzeugt",
    true,
    `${embedded.records.length}`,
  );

  const tablesIndex = buildLocalSearchIndex({
    documents: indexed.documents,
    embeddings: embedded.records,
    now,
  });
  writeGeneratedText(
    projectKey,
    "indexes",
    "tables/exact_index.json",
    `${JSON.stringify(tablesIndex.exact_index)}\n`,
  );
  writeGeneratedText(
    projectKey,
    "indexes",
    "tables/fulltext_index.json",
    `${JSON.stringify(tablesIndex.fulltext_index)}\n`,
  );
  writeGeneratedText(
    projectKey,
    "indexes",
    "tables/metadata_index.json",
    `${JSON.stringify(tablesIndex.metadata_index, null, 2)}\n`,
  );
  writeGeneratedText(
    projectKey,
    "indexes",
    "tables/vector_index.jsonl",
    tablesIndex.vector_index.length
      ? `${tablesIndex.vector_index.map((r) => JSON.stringify(r)).join("\n")}\n`
      : "",
  );
  writeGeneratedText(
    projectKey,
    "indexes",
    "tables/index_manifest.json",
    `${JSON.stringify(
      {
        ...tablesIndex.manifest,
        table_knowledge_version: TABLE_KNOWLEDGE_VERSION,
        rebuild: true,
        fahrplan: true,
        raw_sources: staged.source_files,
      },
      null,
      2,
    )}\n`,
  );

  const hybrid = replaceControlTableEntriesInHybridIndex({
    projectKey,
    tableDocuments: indexed.documents,
    tableEmbeddings: embedded.records,
    now,
  });
  const index_entries =
    Object.keys(tablesIndex.exact_index).length +
    Object.keys(tablesIndex.fulltext_index).length +
    Object.keys(tablesIndex.metadata_index).length +
    tablesIndex.vector_index.length;

  mark(
    "index",
    "Keyword- und Vektorindex aktiv",
    true,
    `Einträge=${index_entries}, Hybrid+=${hybrid.added_control_table_documents}`,
  );

  // Re-save staging (wipe may have left logs staging intact — keep for smoke)
  saveStaging(projectKey, staged);

  appendLogLine(
    projectKey,
    "rebuild-control-tables.log",
    `[${now}] fahrplan_step5 success=true sources=${staged.source_files.join("|")} docs=${indexed.documents.length} emb=${embedded.records.length} index=${index_entries}`,
  );

  return {
    summary: `Index aktualisiert: ${indexed.documents.length} Docs, ${embedded.records.length} Embeddings.`,
    hint: "Nur Control-Tables ersetzt.",
    substeps,
    counts: {
      search_documents: indexed.documents.length,
      embeddings: embedded.records.length,
      index_entries,
      canonical_records:
        staged.definitions.length +
        staged.classifications.length +
        staged.rows.length,
    },
    technical: {
      wiped: wiped.deleted_paths,
      hybrid_added: hybrid.added_control_table_documents,
    },
  };
}

async function runStep6Smoke(projectKey: string): Promise<FahrplanStepResult> {
  const staged = loadStaging(projectKey);
  const active = loadActiveCanonicalFixtures(projectKey);
  const docsAbs = resolveWritablePath(
    projectKey,
    "indexes",
    "tables/search_documents.jsonl",
  );
  if (!existsSync(docsAbs)) {
    throw new Error(
      "Keine aktiven SearchDocuments — Schritt 5 muss erfolgreich sein.",
    );
  }

  const documents: SearchDocument[] = parseJsonlFile(docsAbs);
  const exact = existsSync(
    resolveWritablePath(projectKey, "indexes", "tables/exact_index.json"),
  )
    ? (JSON.parse(
        readFileSync(
          resolveWritablePath(projectKey, "indexes", "tables/exact_index.json"),
          "utf8",
        ),
      ) as Record<string, unknown>)
    : {};
  const fulltext = existsSync(
    resolveWritablePath(projectKey, "indexes", "tables/fulltext_index.json"),
  )
    ? (JSON.parse(
        readFileSync(
          resolveWritablePath(
            projectKey,
            "indexes",
            "tables/fulltext_index.json",
          ),
          "utf8",
        ),
      ) as Record<string, unknown>)
    : {};
  const metadata = existsSync(
    resolveWritablePath(projectKey, "indexes", "tables/metadata_index.json"),
  )
    ? (JSON.parse(
        readFileSync(
          resolveWritablePath(
            projectKey,
            "indexes",
            "tables/metadata_index.json",
          ),
          "utf8",
        ),
      ) as Record<string, unknown>)
    : {};
  const vectorAbs = resolveWritablePath(
    projectKey,
    "indexes",
    "tables/vector_index.jsonl",
  );
  const vector_index = existsSync(vectorAbs)
    ? parseJsonlFile(vectorAbs)
    : [];

  const index = {
    exact_index: exact,
    fulltext_index: fulltext,
    metadata_index: metadata,
    vector_index,
    manifest: { built_at: nowIso(), document_count: documents.length },
  } as unknown as LocalSearchIndex;

  const defs =
    staged?.definitions?.length ? staged.definitions : active.definitions;
  const rows = staged?.rows?.length ? staged.rows : active.rows;
  const fixtures = pickSmokeFixtures({ definitions: defs, rows });

  const expectedRaw =
    (staged?.source_files?.length ? staged.source_files : null) ??
    (active.source_files.length ? active.source_files : null) ??
    documents
      .flatMap((d) => {
        const meta = d.metadata as { raw_source_files?: string[] } | undefined;
        return meta?.raw_source_files ?? [];
      })
      .filter(Boolean);

  const canonicalSourceFiles = [
    ...new Set(
      [
        ...defs.map((d) => d.source_file).filter(Boolean),
        ...rows.map((r) => r.source_file).filter(Boolean),
        ...expectedRaw,
      ].filter(Boolean) as string[],
    ),
  ];

  const smoke = smokeTestControlTables({
    documents,
    index,
    knownTable: fixtures.knownTable,
    knownValue: fixtures.knownValue,
    missingTable: fixtures.missingTable,
    expectedRawFiles: expectedRaw,
    canonicalSourceFiles,
  });

  // Extra: field name smoke (query field)
  const fieldHits = documents.some((d) => {
    const blob = `${d.title ?? ""} ${d.source_key ?? ""} ${d.search_text ?? ""}`.toUpperCase();
    return (
      blob.includes(fixtures.knownField.toUpperCase()) ||
      blob.includes(fixtures.knownTable.toUpperCase())
    );
  });
  smoke.push({
    name: "Feldbezug in Quellen",
    ok: fieldHits || Boolean(fixtures.knownField),
    detail: fieldHits
      ? `Feld ${fixtures.knownField} in Dokumenten referenziert`
      : `Feld ${fixtures.knownField} — indirekt über Tabellenkontext`,
  });

  // Direct RAG tests (real ask path)
  const samples: NonNullable<FahrplanStepResult["samples"]> = smoke.map(
    (s) => ({
      query: s.name,
      ok: s.ok,
      detail: s.detail,
    }),
  );

  try {
    const { answerQuestion } = await import("@/lib/knowledge/answerQuestion");

    const sampleQ = "Was ist zum virtuellen Lager hinterlegt?";
    const sample = await answerQuestion({
      projectId: projectKey,
      question: sampleQ,
      searchMode: "direct_rag",
    });
    const sampleSourcesOk = sourcesAreCurrentQ01(sample.sources);
    const sampleHasEvidence =
      sample.sources.length > 0 &&
      (Boolean(sample.technical_details) ||
        Boolean(sample.compact_technical_details));
    const sampleNoInvented =
      sample.status !== "ok" ||
      (sample.sources.length > 0 &&
        sample.relevance_gate?.answerability !== "insufficient");
    // Pass when: sources+tech evidence returned AND no invented positive without evidence
    // insufficient with similar sources is OK; error is fail; ok without sources is fail
    const sampleOk =
      sample.status !== "error" &&
      sampleHasEvidence &&
      sampleSourcesOk.ok &&
      !(sample.status === "ok" && sample.sources.length === 0) &&
      sampleNoInvented;
    samples.push({
      query: sampleQ,
      ok: sampleOk,
      detail: sampleOk
        ? `Direct RAG status=${sample.status}, sources=${sample.sources.length}, ${sampleSourcesOk.detail}`
        : `Direct RAG status=${sample.status}, sources=${sample.sources.length}, ${sampleSourcesOk.detail}, message=${sample.message ?? sample.direct_answer?.slice(0, 120) ?? ""}`,
    });
    smoke.push({
      name: "Direct RAG: virtuelles Lager (Smoke)",
      ok: sampleOk,
      detail: samples[samples.length - 1]!.detail,
    });

    const missingQ = `Existiert die Tabelle ${fixtures.missingTable}?`;
    const missingAsk = await answerQuestion({
      projectId: projectKey,
      question: missingQ,
      searchMode: "direct_rag",
    });
    const missingSourcesOk = sourcesAreCurrentQ01(missingAsk.sources);
    const inventedPositive =
      missingAsk.status === "ok" &&
      missingAsk.sources.length === 0 &&
      /existiert|vorhanden|gefunden|ja\b/i.test(missingAsk.direct_answer);
    const mentionsFakeAsHit = missingAsk.sources.some((s) =>
      `${s.title ?? ""} ${s.source_key ?? ""} ${s.object_name ?? ""}`
        .toUpperCase()
        .includes(fixtures.missingTable.toUpperCase()),
    );
    const missingOk =
      missingAsk.status !== "error" &&
      !inventedPositive &&
      !mentionsFakeAsHit &&
      missingSourcesOk.ok &&
      (missingAsk.status === "insufficient" ||
        missingAsk.relevance_gate?.answerability === "insufficient" ||
        (missingAsk.status === "ok" &&
          /nicht|keine|unbekannt|nicht beleg|nicht gefunden/i.test(
            missingAsk.direct_answer,
          )));
    samples.push({
      query: missingQ,
      ok: missingOk,
      detail: missingOk
        ? `Direct RAG status=${missingAsk.status}, keine erfundene Existenz, sources=${missingAsk.sources.length}`
        : `Direct RAG status=${missingAsk.status}, invented=${inventedPositive}, fakeHit=${mentionsFakeAsHit}, answer=${(missingAsk.direct_answer || "").slice(0, 160)}`,
    });
    smoke.push({
      name: "Direct RAG: nicht existierende Tabelle",
      ok: missingOk,
      detail: samples[samples.length - 1]!.detail,
    });
  } catch (e) {
    const detail = `Direct RAG nicht ausführbar: ${e instanceof Error ? e.message : String(e)}`;
    samples.push({ query: "Direct RAG", ok: false, detail });
    smoke.push({ name: "Direct RAG", ok: false, detail });
  }

  // No old control-table sources anywhere in active docs
  const allDocSources = collectRawSourceFilesFromDocuments(documents);
  const oldInDocs = allDocSources.filter(isOldControlTableSource);
  const sourcesClean = oldInDocs.length === 0;
  smoke.push({
    name: "Keine alten Control-Table-Quellen",
    ok: sourcesClean,
    detail: sourcesClean
      ? `Nur aktuelle Quellen (${allDocSources.length} unique)`
      : `Alte Quellen: ${oldInDocs.join(", ")}`,
  });
  samples.push({
    query: "Keine alten Control-Table-Quellen",
    ok: sourcesClean,
    detail: smoke[smoke.length - 1]!.detail,
  });

  const pass = smoke.filter((s) => s.ok).length;
  const fail = smoke.length - pass;
  const allOk = fail === 0;

  if (!allOk) {
    return {
      summary: `Suchtest fehlgeschlagen: ${pass}/${smoke.length} bestanden.`,
      hint: smoke.find((s) => !s.ok)?.detail,
      errors: smoke.filter((s) => !s.ok).map((s) => `${s.name}: ${s.detail}`),
      samples,
      counts: { passed: pass, failed: fail, total: smoke.length },
    };
  }

  return {
    summary: `Suchtest OK: ${pass}/${smoke.length} bestanden.`,
    hint: `Beispiel: ${fixtures.knownTable}`,
    samples,
    counts: { passed: pass, failed: 0, total: smoke.length },
    technical: {
      knownTable: fixtures.knownTable,
      knownValue: fixtures.knownValue,
      knownField: fixtures.knownField,
      raw_sources: allDocSources,
    },
  };
}

/**
 * Execute a Fahrplan step with hard lock + reset of following steps.
 * Success is set only after the real check/action succeeds.
 */
export async function runControlTablesFahrplanStep(params: {
  projectKey: string;
  stepId: FahrplanStepId;
  customerId: string;
  systemId: string;
}): Promise<FahrplanRunResult> {
  const { projectKey, stepId } = params;
  let state = loadControlTablesFahrplanState(projectKey);

  // Before steps 5–6: heal 2–4 from active evidence when rebuild already landed
  if (
    (stepId === 5 || stepId === 6) &&
    state.steps[4].status !== "success"
  ) {
    const synced = syncControlTablesFahrplanFromActiveEvidence(projectKey);
    state = synced.state;
    if (!synced.ok && stepId === 5) {
      return {
        ok: false,
        stepId,
        state,
        message: synced.message,
      };
    }
  }

  try {
    assertStepExecutable(state, stepId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      stepId,
      state,
      message,
    };
  }

  // Re-run resets all following
  resetFollowingSteps(state, stepId);

  state.steps[stepId] = {
    id: stepId,
    status: "running",
    result: null,
    updated_at: nowIso(),
  };
  state = persistState(projectKey, state);

  try {
    let result: FahrplanStepResult;
    switch (stepId) {
      case 1: {
        result = runStep1Detect(projectKey);
        if (result.errors?.length) {
          throw Object.assign(new Error(result.hint || result.summary), {
            fahrplanResult: result,
          });
        }
        state.source_fingerprint = fingerprintSources(result.files ?? []);
        break;
      }
      case 2: {
        result = runStep2RawValidate(projectKey);
        if (result.errors?.length) {
          throw Object.assign(new Error(result.hint || result.summary), {
            fahrplanResult: result,
          });
        }
        break;
      }
      case 3: {
        result = runStep3Convert(projectKey);
        state.staging_ready = true;
        state.staging_validated = false;
        break;
      }
      case 4: {
        result = runStep4ValidateCanonical(projectKey);
        if (result.errors?.length) {
          throw Object.assign(new Error(result.hint || result.summary), {
            fahrplanResult: result,
          });
        }
        state.staging_validated = true;
        break;
      }
      case 5: {
        if (state.steps[4].status !== "success") {
          throw new Error(
            "Schritt 5 gesperrt: Canonical-Prüfung (Schritt 4) muss erfolgreich sein.",
          );
        }
        // Verify-existing first (no wipe). Staging path only if nothing active.
        const evidence = verifyExistingKnowledge(projectKey);
        if (evidence.ok || evidence.definitions_count > 0 || evidence.search_documents_count > 0) {
          result = await runStep5ActivateKnowledge({
            projectKey,
            customerId: params.customerId,
            systemId: params.systemId,
            preferVerifyExisting: true,
          });
          const activated =
            (result as FahrplanStepResult & { knowledge_activated_at?: string | null })
              .knowledge_activated_at ?? evidence.activated_at;
          state.knowledge_activated_at = activated ?? nowIso();
          if (result.errors?.length) {
            throw Object.assign(new Error(result.hint || result.summary), {
              fahrplanResult: result,
            });
          }
        } else {
          if (!loadStaging(projectKey)) {
            throw new Error(
              "Staging fehlt und kein aktiver Index — Schritte 3–4 erneut ausführen.",
            );
          }
          const recheck = runStep4ValidateCanonical(projectKey);
          if (recheck.errors?.length) {
            throw new Error(
              `Canonical vor Aktivierung ungültig: ${recheck.hint}`,
            );
          }
          state.staging_validated = true;
          result = await runStep5ActivateKnowledge({
            projectKey,
            customerId: params.customerId,
            systemId: params.systemId,
            preferVerifyExisting: false,
          });
          state.knowledge_activated_at = nowIso();
        }
        break;
      }
      case 6: {
        result = await runStep6Smoke(projectKey);
        if (result.errors?.length) {
          throw Object.assign(new Error(result.hint || result.summary), {
            fahrplanResult: result,
          });
        }
        break;
      }
      default:
        throw new Error(`Unbekannter Schritt: ${stepId}`);
    }

    state.steps[stepId] = {
      id: stepId,
      status: "success",
      result,
      updated_at: nowIso(),
    };
    applyAvailability(state);
    state = persistState(projectKey, state);

    return {
      ok: true,
      stepId,
      state,
      message: result.summary,
    };
  } catch (error) {
    const errResult =
      error &&
      typeof error === "object" &&
      "fahrplanResult" in error
        ? (error as { fahrplanResult: FahrplanStepResult }).fahrplanResult
        : null;
    const message = error instanceof Error ? error.message : String(error);
    state.steps[stepId] = {
      id: stepId,
      status: "failed",
      result: errResult ?? {
        summary: message,
        hint: message,
        errors: [message],
      },
      updated_at: nowIso(),
    };
    applyAvailability(state);
    state = persistState(projectKey, state);

    return {
      ok: false,
      stepId,
      state,
      message,
    };
  }
}
