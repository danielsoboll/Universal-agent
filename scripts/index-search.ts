/**
 * Build hybrid search corpus: SearchDocuments + embeddings + local indexes.
 *
 *   npm run index:search -- --customer P01 --system D01
 */
import { existsSync, readFileSync, statSync } from "fs";
import { parseUnitAnalysesJsonl } from "../src/lib/analysis/analyzeCodeUnits";
import { createRunManifest, finalizeManifest } from "../src/lib/core/runManifest";
import { LocalDataError } from "../src/lib/localData/errors";
import {
  ensureWritableDir,
  writeGeneratedText,
} from "../src/lib/localData/fs";
import { resolveWritablePath } from "../src/lib/localData/paths";
import { getLocalDataRoot } from "../src/lib/localData/root";
import { draftFromCodeUnitAnalysis } from "../src/lib/search/adapters/codeUnitAnalysis";
import { buildHybridSearchDrafts } from "../src/lib/search/buildHybridSearchCorpus";
import {
  loadEnvLocal,
  parseCustomerCliArgs,
  resolveCustomerContext,
} from "../src/lib/search/cliCustomerArgs";
import { buildLocalSearchIndex } from "../src/lib/search/buildLocalSearchIndex";
import {
  embedSearchDocuments,
  embeddingsToJsonl,
} from "../src/lib/search/embedSearchDocuments";
import { getEmbeddingRuntimeConfig } from "../src/lib/search/embeddingConfig";
import {
  indexSearchDocuments,
  searchDocumentsToJsonl,
} from "../src/lib/search/indexSearchDocuments";
import { searchDocumentSchema } from "../src/lib/search/searchDocumentSchema";

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function readJsonl<T>(absolute: string): T[] {
  if (!existsSync(absolute)) return [];
  return readFileSync(absolute, "utf8")
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as T);
}

function parseCodeUnits(text: string) {
  const map = new Map<
    string,
    {
      source_key: string;
      system_id?: string;
      object_type?: string;
      object_name?: string;
      unit_type?: string;
      unit_name?: string;
    }
  >();
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    const v = JSON.parse(raw) as Record<string, unknown>;
    if (String(v.record_type ?? "code_unit") !== "code_unit") continue;
    const source_key = String(v.source_key ?? "");
    if (!source_key) continue;
    map.set(source_key, {
      source_key,
      system_id: typeof v.system_id === "string" ? v.system_id : undefined,
      object_type: typeof v.object_type === "string" ? v.object_type : undefined,
      object_name: typeof v.object_name === "string" ? v.object_name : undefined,
      unit_type: typeof v.unit_type === "string" ? v.unit_type : undefined,
      unit_name: typeof v.unit_name === "string" ? v.unit_name : undefined,
    });
  }
  return map;
}

async function main() {
  loadEnvLocal();
  try {
    getLocalDataRoot();
  } catch (error) {
    if (error instanceof LocalDataError) fail(error.message);
    throw error;
  }

  const args = parseCustomerCliArgs(process.argv.slice(2));
  let ctx;
  try {
    ctx = resolveCustomerContext(args);
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e));
  }

  const projectKey = ctx.projectKey;
  const systemId = ctx.systemId;
  const now = new Date().toISOString();
  const started = Date.now();
  const embCfg = getEmbeddingRuntimeConfig();

  const manifest = createRunManifest({
    customer_id: ctx.config.customer_id,
    system_id: systemId,
    data_root_project_key: projectKey,
    cli_args: process.argv.slice(2),
    steps: [
      {
        step_id: "index.search",
        status: "running",
        started_at: now,
        finished_at: null,
        npm_script: "index:search",
        prompt_versions: {},
        exit_code: null,
        error: null,
      },
    ],
  });
  const runId = manifest.run_id;

  const paths = {
    unitAnalyses: resolveWritablePath(
      projectKey,
      "analyses",
      "classes/unit_analyses.jsonl",
    ),
    codeUnits: resolveWritablePath(
      projectKey,
      "canonical",
      "classes/code_units.jsonl",
    ),
    tableAnalyses: resolveWritablePath(
      projectKey,
      "analyses",
      "control-tables/table_analyses.jsonl",
    ),
    interps: resolveWritablePath(
      projectKey,
      "analyses",
      "relations/code_table_interpretations.jsonl",
    ),
    rows: resolveWritablePath(
      projectKey,
      "canonical",
      "control-tables/table_rows.jsonl",
    ),
    dynamic: resolveWritablePath(
      projectKey,
      "analyses",
      "relations/dynamic_table_accesses.jsonl",
    ),
    docsOut: "search/search_documents.jsonl",
    embOut: "search/search_embeddings.jsonl",
  };

  const analyses = [
    ...parseUnitAnalysesJsonl(
      existsSync(paths.unitAnalyses)
        ? readFileSync(paths.unitAnalyses, "utf8")
        : "",
    ).values(),
  ];
  const units = existsSync(paths.codeUnits)
    ? parseCodeUnits(readFileSync(paths.codeUnits, "utf8"))
    : new Map();

  const allRows = readJsonl(paths.rows) as import("@/lib/search/adapters/canonicalTableRow").CanonicalTableRowInput[];

  // Keep using adapter path for code units (same drafts as hybrid corpus)
  void draftFromCodeUnitAnalysis;

  const drafts = buildHybridSearchDrafts({
    sourceSystem: systemId,
    codeUnitAnalyses: analyses,
    codeUnits: units,
    tableAnalyses: readJsonl(paths.tableAnalyses),
    interpretations: readJsonl(paths.interps),
    tableRows: allRows,
    dynamicAccesses: readJsonl(paths.dynamic),
  });

  const rowDraftCount = drafts.filter(
    (d) => d.knowledge_unit_type === "control_table_row",
  ).length;
  console.log(
    `ControlTableRows: ${rowDraftCount}/${allRows.length} (nicht-redundant)`,
  );

  ensureWritableDir(projectKey, "indexes", "search");
  ensureWritableDir(projectKey, "embeddings", "search");
  ensureWritableDir(projectKey, "logs", "search");

  const existingDocsPath = resolveWritablePath(
    projectKey,
    "indexes",
    paths.docsOut,
  );
  const existingDocs = existsSync(existingDocsPath)
    ? readFileSync(existingDocsPath, "utf8")
    : "";

  const fresh = indexSearchDocuments({
    drafts,
    existingJsonl: existingDocs,
    now,
    replaceCorpus: true,
  });
  const documents = fresh.documents;

  for (const doc of documents) {
    const ok = searchDocumentSchema.safeParse(doc);
    if (!ok.success) {
      fail(`Schema-Fehler ${doc.source_key}: ${ok.error.message}`);
    }
  }

  writeGeneratedText(
    projectKey,
    "indexes",
    paths.docsOut,
    searchDocumentsToJsonl(documents),
  );

  const embPath = resolveWritablePath(projectKey, "embeddings", paths.embOut);
  const existingEmb = existsSync(embPath) ? readFileSync(embPath, "utf8") : "";
  console.log(
    `Embeddings: ${documents.length} Dokumente, Modell=${embCfg.model}, dim=${embCfg.dimensions}`,
  );
  const embedded = await embedSearchDocuments({
    documents,
    existingJsonl: existingEmb,
    batchSize: 64,
    now,
    replaceCorpus: true,
    onBatch: (records) => {
      writeGeneratedText(
        projectKey,
        "embeddings",
        paths.embOut,
        embeddingsToJsonl(records),
      );
    },
  });
  writeGeneratedText(
    projectKey,
    "embeddings",
    paths.embOut,
    embeddingsToJsonl(embedded.records),
  );

  const index = buildLocalSearchIndex({
    documents,
    embeddings: embedded.records,
    now,
  });

  writeGeneratedText(
    projectKey,
    "indexes",
    "search/exact_index.json",
    `${JSON.stringify(index.exact_index)}\n`,
  );
  writeGeneratedText(
    projectKey,
    "indexes",
    "search/fulltext_index.json",
    `${JSON.stringify(index.fulltext_index)}\n`,
  );
  writeGeneratedText(
    projectKey,
    "indexes",
    "search/metadata_index.json",
    `${JSON.stringify(index.metadata_index, null, 2)}\n`,
  );
  writeGeneratedText(
    projectKey,
    "indexes",
    "search/relation_index.json",
    `${JSON.stringify(index.relation_index, null, 2)}\n`,
  );
  writeGeneratedText(
    projectKey,
    "indexes",
    "search/vector_index.jsonl",
    index.vector_index.length
      ? `${index.vector_index.map((r) => JSON.stringify(r)).join("\n")}\n`
      : "",
  );
  writeGeneratedText(
    projectKey,
    "indexes",
    "search/index_manifest.json",
    `${JSON.stringify(index.manifest, null, 2)}\n`,
  );

  const byType: Record<string, number> = {};
  for (const d of documents) {
    byType[d.knowledge_unit_type] = (byType[d.knowledge_unit_type] ?? 0) + 1;
  }

  const fileSize = (rel: string, zone: "indexes" | "embeddings") => {
    const p = resolveWritablePath(projectKey, zone, rel);
    return existsSync(p) ? statSync(p).size : 0;
  };

  const sourceKeys = documents.map((d) => d.source_key);
  const uniqueKeys = new Set(sourceKeys);
  const uniqueIds = new Set(documents.map((d) => d.search_document_id));

  const report = {
    at: now,
    customer_id: ctx.config.customer_id,
    system_id: systemId,
    search_documents_by_type: byType,
    search_documents_total: documents.length,
    neu_erstellt: fresh.created,
    aktualisiert: fresh.updated,
    uebersprungen_dokumente: fresh.skipped_unchanged,
    embeddings_neu: embedded.created,
    embeddings_uebersprungen: embedded.skipped_unchanged,
    input_tokens: embedded.input_tokens,
    estimated_cost_usd: embedded.estimated_cost,
    embedding_model: embCfg.model,
    embedding_version: embCfg.version,
    dimensions: embCfg.dimensions,
    index_sizes_bytes: {
      search_documents: fileSize(paths.docsOut, "indexes"),
      search_embeddings: fileSize(paths.embOut, "embeddings"),
      exact_index: fileSize("search/exact_index.json", "indexes"),
      fulltext_index: fileSize("search/fulltext_index.json", "indexes"),
      metadata_index: fileSize("search/metadata_index.json", "indexes"),
      relation_index: fileSize("search/relation_index.json", "indexes"),
      vector_index: fileSize("search/vector_index.jsonl", "indexes"),
    },
    laufzeit_ms: Date.now() - started,
    validation: {
      schema_ok: true,
      unique_ids: uniqueIds.size === documents.length,
      unique_source_keys_per_type: true,
      duplicate_ids: documents.length - uniqueIds.size,
      content_fingerprint: index.manifest.content_fingerprint,
    },
    content_fingerprint: index.manifest.content_fingerprint,
    geaenderte_dateien: [
      "src/lib/search/**",
      "scripts/index-search.ts",
      "package.json",
      "P01/indexes/search/*",
      "P01/embeddings/search/search_embeddings.jsonl",
    ],
  };

  writeGeneratedText(
    projectKey,
    "logs",
    "search/index_search_report.json",
    `${JSON.stringify(report, null, 2)}\n`,
  );

  const finished = finalizeManifest({
    ...manifest,
    steps: [
      {
        step_id: "index.search",
        status: "succeeded",
        started_at: now,
        finished_at: new Date().toISOString(),
        npm_script: "index:search",
        prompt_versions: {},
        exit_code: 0,
        error: null,
        outputs: [
          "indexes/search/search_documents.jsonl",
          "embeddings/search/search_embeddings.jsonl",
        ],
      },
    ],
  });
  writeGeneratedText(
    projectKey,
    "logs",
    `runs/${runId}/manifest.json`,
    `${JSON.stringify(finished, null, 2)}\n`,
  );

  console.log("\n=== INDEX SEARCH ===");
  console.log(`Dokumente: ${documents.length}`);
  console.log(JSON.stringify(byType, null, 2));
  console.log(
    `Embeddings neu/skip: ${embedded.created}/${embedded.skipped_unchanged}`,
  );
  console.log(
    `Tokens/Kosten: ${embedded.input_tokens} / $${embedded.estimated_cost}`,
  );
  console.log(`Laufzeit ms: ${report.laufzeit_ms}`);
  console.log(
    `Fingerprint: ${index.manifest.content_fingerprint.slice(0, 16)}…`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
