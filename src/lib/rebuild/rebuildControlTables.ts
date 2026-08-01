import { createHash } from "crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { canonicalizeControlTableSources } from "@/lib/ingest/controlTables/canonicalize";
import { recordsToJsonl } from "@/lib/ingest/controlTables/model";
import {
  appendLogLine,
  deleteGeneratedPath,
  ensureWritableDir,
  readRawBuffer,
  writeGeneratedText,
} from "@/lib/localData/fs";
import { replaceControlTableEntriesInHybridIndex } from "@/lib/rebuild/mergeHybridIndex";
import { smokeTestControlTables } from "@/lib/rebuild/smokeControlTables";
import type {
  RebuildStatusStep,
  RebuildTypeReport,
  RawSourceFile,
} from "@/lib/rebuild/types";
import { REBUILD_STATUS_LABELS_DE } from "@/lib/rebuild/types";
import { validateRawSourcesForType } from "@/lib/rebuild/validateRawSources";
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
import { buildCodeTableBindings } from "@/lib/tables/buildCodeTableBindings";
import { buildTableKnowledgeUnits } from "@/lib/tables/buildTableKnowledgeUnits";
import { buildTableRowEvidence } from "@/lib/tables/buildTableRowEvidence";
import { buildTableRuleGroups } from "@/lib/tables/buildTableRuleGroups";
import { buildAllTableSearchDrafts } from "@/lib/tables/draftTableSearchDocuments";
import { buildTableCorpusFromCanonical } from "@/lib/tables/loadCanonicalTables";
import { TABLE_KNOWLEDGE_VERSION } from "@/lib/tables/types";
import type { SearchDocument } from "@/lib/search/searchDocumentSchema";

function fileSha256(absolutePath: string): string {
  return createHash("sha256").update(readFileSync(absolutePath)).digest("hex");
}

function writeJsonl(projectKey: string, rel: string, rows: object[]) {
  const body = rows.length
    ? `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`
    : "";
  writeGeneratedText(projectKey, "indexes", rel, body);
}

function pickSmokeFixtures(params: {
  definitions: Array<{ table_name: string; source_file?: string }>;
  rows: Array<{
    table_name: string;
    primary_key: Record<string, string>;
    values: Record<string, string>;
    source_file?: string;
  }>;
}): { knownTable: string; knownValue: string; missingTable: string } {
  const withRows = params.rows[0];
  const knownTable =
    withRows?.table_name ||
    params.definitions.find((d) => d.table_name)?.table_name ||
    "ZUNKNOWN";
  let knownValue = "";
  if (withRows) {
    const fromPk = Object.values(withRows.primary_key ?? {}).find(
      (v) => v && v !== "001" && String(v).length >= 2,
    );
    const fromVals = Object.entries(withRows.values ?? {})
      .filter(([k]) => k.toUpperCase() !== "MANDT")
      .map(([, v]) => String(v))
      .find((v) => v.length >= 2 && v.length <= 40);
    knownValue = String(fromPk || fromVals || knownTable);
  } else {
    knownValue = knownTable;
  }
  return {
    knownTable,
    knownValue,
    missingTable: "ZZZZ_DOES_NOT_EXIST_TABLE_9X9X",
  };
}

function writeStatus(
  projectKey: string,
  payload: Record<string, unknown>,
) {
  writeGeneratedText(
    projectKey,
    "logs",
    "rebuild-control-tables-status.json",
    `${JSON.stringify(payload, null, 2)}\n`,
  );
}

function validateStagedCanonical(params: {
  definitions: unknown[];
  classifications: unknown[];
  rows: unknown[];
  entities: unknown[];
  relations: unknown[];
}): void {
  if (params.definitions.length === 0) {
    throw new Error(
      "Canonical-Validierung fehlgeschlagen: keine table_definitions.",
    );
  }
  for (const d of params.definitions as Array<Record<string, unknown>>) {
    if (
      d.record_type !== "table_definition" ||
      typeof d.table_name !== "string" ||
      !d.table_name ||
      typeof d.source_key !== "string" ||
      !d.source_key
    ) {
      throw new Error(
        `Canonical-Validierung fehlgeschlagen: ungültige Definition ${String(d.source_key ?? d.table_name)}`,
      );
    }
  }
  for (const r of params.rows as Array<Record<string, unknown>>) {
    if (
      r.record_type !== "table_row" ||
      typeof r.table_name !== "string" ||
      !r.table_name ||
      typeof r.source_key !== "string" ||
      !r.source_key
    ) {
      throw new Error(
        `Canonical-Validierung fehlgeschlagen: ungültige Zeile ${String(r.source_key ?? r.table_name)}`,
      );
    }
  }
  // Ensure staging JSONL round-trips (structural write check in OS temp)
  const stagingDir = mkdtempSync(path.join(tmpdir(), "ga-ct-stage-"));
  try {
    writeFileSync(
      path.join(stagingDir, "table_definitions.jsonl"),
      recordsToJsonl(params.definitions as Record<string, unknown>[]),
      "utf8",
    );
    writeFileSync(
      path.join(stagingDir, "table_classifications.jsonl"),
      recordsToJsonl(params.classifications as Record<string, unknown>[]),
      "utf8",
    );
    writeFileSync(
      path.join(stagingDir, "table_rows.jsonl"),
      recordsToJsonl(params.rows as Record<string, unknown>[]),
      "utf8",
    );
    writeFileSync(
      path.join(stagingDir, "table_entities.jsonl"),
      recordsToJsonl(params.entities as Record<string, unknown>[]),
      "utf8",
    );
    writeFileSync(
      path.join(stagingDir, "table_relations.jsonl"),
      recordsToJsonl(params.relations as Record<string, unknown>[]),
      "utf8",
    );
    for (const name of [
      "table_definitions.jsonl",
      "table_classifications.jsonl",
      "table_rows.jsonl",
      "table_entities.jsonl",
      "table_relations.jsonl",
    ]) {
      const text = readFileSync(path.join(stagingDir, name), "utf8");
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        JSON.parse(line);
      }
    }
  } finally {
    rmSync(stagingDir, { recursive: true, force: true });
  }
}

function validateStagedSearchDocuments(docs: SearchDocument[]): void {
  if (docs.length === 0) {
    throw new Error(
      "SearchDocuments-Validierung fehlgeschlagen: keine Dokumente erzeugt.",
    );
  }
  for (const doc of docs) {
    const ok = searchDocumentSchema.safeParse(doc);
    if (!ok.success) {
      throw new Error(
        `SearchDocument ungültig ${doc.source_key}: ${ok.error.message}`,
      );
    }
  }
}

function emptyFailReport(params: {
  projectKey: string;
  sources: RawSourceFile[];
  lines_read: number;
  steps_completed: RebuildStatusStep[];
  started: number;
  now: string;
  error: string;
  structural_validation_ok: boolean;
}): RebuildTypeReport {
  return {
    project: params.projectKey,
    type: "control-tables",
    source_files: params.sources.map((s) => s.relativePath),
    source_sizes: params.sources.map((s) => s.bytes),
    source_sha256: params.sources.map((s) => s.sha256 ?? ""),
    lines_read: params.lines_read,
    structural_validation_ok: params.structural_validation_ok,
    error_count: 1,
    canonical_records: 0,
    search_documents: 0,
    embeddings: 0,
    index_entries: 0,
    old_deleted: false,
    success: false,
    smoke_ok: false,
    derived_replaced: false,
    no_new_folder_structure: true,
    smoke: [],
    steps_completed: params.steps_completed,
    at: params.now,
    duration_ms: Date.now() - params.started,
    error: params.error,
  };
}

/**
 * Transactional prepare-then-swap rebuild for control-tables.
 *
 * Steps 1–4 (validate RAW → stage Canonical → validate → stage SearchDocuments)
 * leave the old generated stand untouched on failure.
 * Step 5+ (wipe → persist → embed → index) has no rollback.
 */
export async function rebuildControlTables(params: {
  projectKey: string;
  customerId: string;
  systemId: string;
  onStep?: (step: RebuildStatusStep, detail?: string) => void;
}): Promise<RebuildTypeReport> {
  const started = Date.now();
  const now = new Date().toISOString();
  const projectKey = params.projectKey;
  const steps_completed: RebuildStatusStep[] = [];
  let old_deleted = false;
  let sources: RawSourceFile[] = [];
  let lines_read = 0;
  let structural_validation_ok = false;

  const mark = (step: RebuildStatusStep, detail?: string) => {
    steps_completed.push(step);
    params.onStep?.(step, detail);
    writeStatus(projectKey, {
      at: new Date().toISOString(),
      project: projectKey,
      type: "control-tables",
      step,
      step_label_de: REBUILD_STATUS_LABELS_DE[step],
      detail: detail ?? null,
      steps_completed: [...steps_completed],
      old_deleted,
    });
  };

  const persistProofLog = (report: RebuildTypeReport) => {
    const proof = {
      timestamp: report.at,
      project: report.project,
      type: report.type,
      raw_paths: report.source_files,
      file_sizes: report.source_sizes,
      sha256: report.source_sha256,
      lines_read: report.lines_read,
      structural_validation_ok: report.structural_validation_ok,
      canonical_count: report.canonical_records,
      searchdoc_count: report.search_documents,
      embedding_count: report.embeddings,
      index_entry_count: report.index_entries,
      old_deleted: report.old_deleted,
      success: report.success,
      error: report.error ?? null,
      duration_ms: report.duration_ms,
    };
    writeGeneratedText(
      projectKey,
      "logs",
      "rebuild-control-tables-report.json",
      `${JSON.stringify({ ...report, proof }, null, 2)}\n`,
    );
    appendLogLine(
      projectKey,
      "rebuild-control-tables.log",
      `[${report.at}] success=${report.success} old_deleted=${report.old_deleted} ` +
        `sources=${report.source_files.join("|")} sizes=${report.source_sizes.join("|")} ` +
        `sha256=${report.source_sha256.join("|")} lines=${report.lines_read} ` +
        `structural_ok=${report.structural_validation_ok} canonical=${report.canonical_records} ` +
        `docs=${report.search_documents} emb=${report.embeddings} index=${report.index_entries}` +
        (report.error ? ` error=${report.error}` : ""),
    );
  };

  try {
    // ── 1) Fully structurally validate RAW ──────────────────────────────
    const validated = validateRawSourcesForType({
      projectKey,
      type: "control-tables",
    });
    sources = validated.sources;
    lines_read = validated.lines_read;
    structural_validation_ok = true;
    mark(
      "raw_validated",
      sources
        .map((s) => `${s.relativePath} (${s.bytes} B, sha256=${s.sha256?.slice(0, 12)}…)`)
        .join("; "),
    );

    const hashesBefore = sources.map((s) => ({
      file: s.relativePath,
      sha256: s.sha256 ?? fileSha256(s.absolutePath),
    }));

    // Converter can process + stage Canonical in memory / OS temp
    const sourcePayloads = sources.map((s) => {
      const parts = s.relativePath.split("/");
      const buffer = readRawBuffer(projectKey, ...parts);
      return {
        text: buffer.toString("utf8"),
        sourceFile: `${parts.slice(1).join("/")}`,
      };
    });

    // ── 2) Fully build new Canonical in temporary/staging ───────────────
    const canonical = canonicalizeControlTableSources(sourcePayloads);
    if (canonical.stats.definitions === 0) {
      throw new Error(
        `Konverter konnte keine gültigen Tabellendefinitionen erzeugen. ` +
          `Zeilen gelesen=${canonical.stats.lines_total}, ungültig=${canonical.stats.invalid}. ` +
          `Alter Wissensstand unverändert.`,
      );
    }

    // ── 3) Fully validate Canonical (incl. OS-temp JSONL round-trip) ────
    validateStagedCanonical({
      definitions: canonical.definitions,
      classifications: canonical.classifications,
      rows: canonical.rows,
      entities: canonical.entities,
      relations: canonical.relations,
    });

    const canonicalRecordCount =
      canonical.definitions.length +
      canonical.classifications.length +
      canonical.rows.length +
      canonical.entities.length +
      canonical.relations.length;

    // ── 4) Successfully build new SearchDocuments (staging / in-memory) ─
    const ingestReportPreview = {
      at: now,
      project: projectKey,
      rebuild: true,
      sources: sources.map((s: RawSourceFile) => ({
        file: s.relativePath.replace(/^control-tables\//, ""),
        bytes: s.bytes,
        sha256: s.sha256,
      })),
      stats: canonical.stats,
      issue_count: canonical.issues.length,
    };

    const bundle = buildTableCorpusFromCanonical({
      projectKey,
      definitions: canonical.definitions,
      classifications: canonical.classifications,
      rows: canonical.rows,
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

    const rawSourceFiles = sources.map((s) => s.relativePath);
    for (const draft of drafts) {
      draft.metadata = {
        ...(draft.metadata ?? {}),
        raw_source_files: rawSourceFiles,
      };
    }

    const indexed = indexSearchDocuments({
      drafts,
      existingJsonl: "",
      now,
      replaceCorpus: true,
    });
    validateStagedSearchDocuments(indexed.documents);

    // RAW must still be unchanged before any destructive step
    for (let i = 0; i < sources.length; i++) {
      const current = fileSha256(sources[i]!.absolutePath);
      if (current !== hashesBefore[i]!.sha256) {
        throw new Error(
          "Raw-Dateien haben sich während der Vorbereitung geändert — Abbruch ohne Löschen.",
        );
      }
    }

    mark(
      "data_prepared",
      `Canonical=${canonicalRecordCount}, SearchDocuments=${indexed.documents.length} (Staging)`,
    );

    // ── 5) Permanently delete old generated data for this type ──────────
    const wiped = wipeDerivedForType({ projectKey, type: "control-tables" });
    old_deleted = true;
    mark(
      "old_wiped",
      wiped.deleted_paths.length
        ? wiped.deleted_paths.join(", ")
        : "keine alten abgeleiteten Pfade vorhanden",
    );

    // ── 6) Persist new Canonical ────────────────────────────────────────
    ensureWritableDir(projectKey, "canonical", "control-tables");
    ensureWritableDir(projectKey, "logs");
    writeGeneratedText(
      projectKey,
      "canonical",
      "control-tables/table_definitions.jsonl",
      recordsToJsonl(canonical.definitions),
    );
    writeGeneratedText(
      projectKey,
      "canonical",
      "control-tables/table_classifications.jsonl",
      recordsToJsonl(canonical.classifications),
    );
    writeGeneratedText(
      projectKey,
      "canonical",
      "control-tables/table_rows.jsonl",
      recordsToJsonl(canonical.rows),
    );
    writeGeneratedText(
      projectKey,
      "canonical",
      "control-tables/table_entities.jsonl",
      recordsToJsonl(canonical.entities),
    );
    writeGeneratedText(
      projectKey,
      "canonical",
      "control-tables/table_relations.jsonl",
      recordsToJsonl(canonical.relations),
    );
    writeGeneratedText(
      projectKey,
      "canonical",
      "control-tables/ingest_report.json",
      `${JSON.stringify(
        {
          ...ingestReportPreview,
          raw_files_unchanged: true,
          issues_sample: canonical.issues.slice(0, 30),
        },
        null,
        2,
      )}\n`,
    );
    writeGeneratedText(
      projectKey,
      "logs",
      "control-tables-ingest-issues.jsonl",
      canonical.issues.length
        ? `${canonical.issues.map((i) => JSON.stringify(i)).join("\n")}\n`
        : "",
    );

    // ── 7) Persist new SearchDocuments (+ knowledge artifacts) ──────────
    ensureWritableDir(projectKey, "indexes", "tables");
    ensureWritableDir(projectKey, "logs", "tables");
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

    // ── 8) Generate new Embeddings ──────────────────────────────────────
    const embedded = await embedSearchDocuments({
      documents: indexed.documents,
      existingJsonl: "",
      replaceCorpus: true,
      now,
      onBatch: (records) => {
        writeGeneratedText(
          projectKey,
          "embeddings",
          "search/rebuild_control_tables_embeddings.tmp.jsonl",
          embeddingsToJsonl(records),
        );
      },
    });
    writeGeneratedText(
      projectKey,
      "embeddings",
      "search/control_tables_embeddings.jsonl",
      embeddingsToJsonl(embedded.records),
    );
    deleteGeneratedPath(
      projectKey,
      "embeddings",
      "search/rebuild_control_tables_embeddings.tmp.jsonl",
    );

    mark(
      "new_built",
      `Canonical=${canonicalRecordCount}, SearchDocuments=${indexed.documents.length}, Embeddings=${embedded.records.length}`,
    );

    // ── 9) Fully rebuild keyword+vector index; activate immediately ─────
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
          raw_sources: rawSourceFiles,
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
      "index_updated",
      `Indexeinträge=${index_entries}, Hybrid+=${hybrid.added_control_table_documents}`,
    );

    // Smoke (optional proof; not for version pick)
    const fixtures = pickSmokeFixtures({
      definitions: canonical.definitions,
      rows: canonical.rows,
    });
    const canonicalSourceFiles = [
      ...new Set(
        [
          ...canonical.definitions.map((d) => d.source_file).filter(Boolean),
          ...canonical.rows.map((r) => r.source_file).filter(Boolean),
          ...ingestReportPreview.sources.map((s) => s.file),
        ].filter(Boolean) as string[],
      ),
    ];
    const smoke = smokeTestControlTables({
      documents: indexed.documents,
      index: tablesIndex,
      knownTable: fixtures.knownTable,
      knownValue: fixtures.knownValue,
      missingTable: fixtures.missingTable,
      expectedRawFiles: sources.map((s) => s.relativePath),
      canonicalSourceFiles,
    });
    const smoke_ok = smoke.every((s) => s.ok);

    mark("done", smoke_ok ? "Neuaufbau erfolgreich" : "Neuaufbau mit Smoke-Warnungen");

    const report: RebuildTypeReport = {
      project: projectKey,
      type: "control-tables",
      source_files: sources.map((s) => s.relativePath),
      source_sizes: sources.map((s) => s.bytes),
      source_sha256: sources.map((s) => s.sha256 ?? ""),
      lines_read: canonical.stats.lines_total,
      structural_validation_ok: true,
      error_count:
        canonical.stats.invalid +
        canonical.issues.filter((i) =>
          ["INVALID_JSON", "SCHEMA"].includes(i.code),
        ).length,
      canonical_records: canonicalRecordCount,
      search_documents: indexed.documents.length,
      embeddings: embedded.records.length,
      index_entries,
      old_deleted: true,
      success: true,
      smoke_ok,
      derived_replaced: true,
      no_new_folder_structure: true,
      smoke,
      steps_completed: [...steps_completed],
      at: now,
      duration_ms: Date.now() - started,
      error: null,
      issues_sample: canonical.issues.slice(0, 20).map((i) => ({
        sourceFile: i.sourceFile,
        lineNumber: i.lineNumber,
        error: i.error,
      })),
    };

    writeGeneratedText(
      projectKey,
      "logs",
      "rebuild-control-tables-report.json",
      `${JSON.stringify(
        {
          ...report,
          wipe: wiped,
          hybrid,
          embed_stats: {
            created: embedded.created,
            skipped_unchanged: embedded.skipped_unchanged,
            input_tokens: embedded.input_tokens,
            estimated_cost: embedded.estimated_cost,
          },
          canonical_stats: canonical.stats,
          proof: {
            timestamp: report.at,
            project: report.project,
            type: report.type,
            raw_paths: report.source_files,
            file_sizes: report.source_sizes,
            sha256: report.source_sha256,
            lines_read: report.lines_read,
            structural_validation_ok: report.structural_validation_ok,
            canonical_count: report.canonical_records,
            searchdoc_count: report.search_documents,
            embedding_count: report.embeddings,
            index_entry_count: report.index_entries,
            old_deleted: report.old_deleted,
            success: report.success,
            error: null,
          },
        },
        null,
        2,
      )}\n`,
    );
    appendLogLine(
      projectKey,
      "rebuild-control-tables.log",
      `[${now}] success=true old_deleted=true sources=${report.source_files.join("|")} ` +
        `sizes=${report.source_sizes.join("|")} sha256=${report.source_sha256.join("|")} ` +
        `lines=${report.lines_read} structural_ok=true canonical=${report.canonical_records} ` +
        `docs=${report.search_documents} emb=${report.embeddings} index=${report.index_entries}`,
    );

    return report;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // If wipe already ran, surface that clearly — no rollback
    writeStatus(projectKey, {
      at: new Date().toISOString(),
      project: projectKey,
      type: "control-tables",
      step: "error",
      step_label_de: old_deleted
        ? "Fehler nach Löschen (kein Rollback)"
        : "Fehler — alter Stand unverändert",
      detail: message,
      steps_completed: [...steps_completed],
      old_deleted,
      error: message,
    });

    const report = emptyFailReport({
      projectKey,
      sources,
      lines_read,
      steps_completed,
      started,
      now,
      error: message,
      structural_validation_ok,
    });
    report.old_deleted = old_deleted;
    report.derived_replaced = old_deleted;
    persistProofLog(report);

    // Before wipe: abort with throw so CLI exits non-zero and old stand remains
    if (!old_deleted) {
      throw error instanceof Error ? error : new Error(message);
    }
    // After wipe: return failed report (no rollback possible)
    return report;
  }
}
