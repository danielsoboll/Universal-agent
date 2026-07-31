/**
 * Prepare full Z/Y table corpus into knowledge units, rule groups,
 * row evidence, code bindings and SearchDocuments (no embeddings).
 *
 *   npm run index:tables -- --customer P01 --system D01
 */
import { existsSync, readFileSync, statSync } from "fs";
import { createRunManifest, finalizeManifest } from "../src/lib/core/runManifest";
import { LocalDataError } from "../src/lib/localData/errors";
import {
  ensureWritableDir,
  writeGeneratedText,
} from "../src/lib/localData/fs";
import { resolveWritablePath } from "../src/lib/localData/paths";
import { getLocalDataRoot } from "../src/lib/localData/root";
import { buildLocalSearchIndex } from "../src/lib/search/buildLocalSearchIndex";
import {
  loadEnvLocal,
  parseCustomerCliArgs,
  resolveCustomerContext,
} from "../src/lib/search/cliCustomerArgs";
import {
  indexSearchDocuments,
  searchDocumentsToJsonl,
} from "../src/lib/search/indexSearchDocuments";
import { searchDocumentSchema } from "../src/lib/search/searchDocumentSchema";
import { buildCodeTableBindings } from "../src/lib/tables/buildCodeTableBindings";
import { buildTableKnowledgeUnits } from "../src/lib/tables/buildTableKnowledgeUnits";
import { buildTableRowEvidence } from "../src/lib/tables/buildTableRowEvidence";
import { buildTableRuleGroups } from "../src/lib/tables/buildTableRuleGroups";
import { buildAllTableSearchDrafts } from "../src/lib/tables/draftTableSearchDocuments";
import { buildTableInventory } from "../src/lib/tables/inventory";
import { loadTableCorpus } from "../src/lib/tables/loadCanonicalTables";
import { searchTablesFulltext } from "../src/lib/tables/searchTablesFulltext";
import { TABLE_KNOWLEDGE_VERSION } from "../src/lib/tables/types";

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function writeJsonl(projectKey: string, rel: string, rows: object[]) {
  const body = rows.length
    ? `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`
    : "";
  writeGeneratedText(projectKey, "indexes", rel, body);
}

function fileMtime(abs: string): number | null {
  if (!existsSync(abs)) return null;
  return statSync(abs).mtimeMs;
}

async function main() {
  const started = Date.now();
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

  const rawGuard = [
    resolveWritablePath(projectKey, "canonical", "control-tables/table_definitions.jsonl"),
    resolveWritablePath(projectKey, "canonical", "control-tables/table_rows.jsonl"),
  ].map((p) => ({ path: p, mtime: fileMtime(p) }));

  const manifest = createRunManifest({
    customer_id: ctx.config.customer_id,
    system_id: systemId,
    data_root_project_key: projectKey,
    cli_args: process.argv.slice(2),
    steps: [
      {
        step_id: "index.tables",
        status: "running",
        started_at: now,
        finished_at: null,
        npm_script: "index:tables",
        prompt_versions: {},
        exit_code: null,
        error: null,
      },
    ],
  });

  const bundle = loadTableCorpus(projectKey);
  if (!bundle.definitions.length) {
    fail("Keine table_definitions.jsonl — zuerst canonicalize:control-tables");
  }

  const inventory = buildTableInventory(bundle);
  console.log("\n=== BESTAND ===");
  console.log(JSON.stringify(inventory, null, 2));

  const units = buildTableKnowledgeUnits({
    bundle,
    customerId: ctx.config.customer_id,
    systemId,
  });
  const ruleGroups = buildTableRuleGroups({ bundle, units });
  const rows = buildTableRowEvidence({ bundle, units, ruleGroups });
  const bindings = buildCodeTableBindings({ bundle, rows, ruleGroups });
  const primaryRows = rows.filter((r) => r.primary_search_document);

  const drafts = buildAllTableSearchDrafts({
    units,
    ruleGroups,
    rows,
    bindings,
    systemId,
  });

  ensureWritableDir(projectKey, "indexes", "tables");
  ensureWritableDir(projectKey, "logs", "tables");

  writeJsonl(projectKey, "tables/table_knowledge_units.jsonl", units);
  writeJsonl(projectKey, "tables/table_rule_groups.jsonl", ruleGroups);
  writeJsonl(projectKey, "tables/table_row_evidence.jsonl", rows);
  writeJsonl(projectKey, "tables/code_table_bindings.jsonl", bindings);

  const existingDocsPath = resolveWritablePath(
    projectKey,
    "indexes",
    "tables/search_documents.jsonl",
  );
  const existingDocs = existsSync(existingDocsPath)
    ? readFileSync(existingDocsPath, "utf8")
    : "";

  const indexed = indexSearchDocuments({
    drafts,
    existingJsonl: existingDocs,
    now,
    replaceCorpus: true,
  });

  for (const doc of indexed.documents) {
    const ok = searchDocumentSchema.safeParse(doc);
    if (!ok.success) {
      fail(`SearchDocument ungültig ${doc.source_key}: ${ok.error.message}`);
    }
  }

  // Evidence refs soft-check
  const rowIds = new Set(rows.map((r) => r.row_id));
  const defKeys = new Set(bundle.definitions.map((d) => d.source_key));
  let unresolvedRefs = 0;
  for (const doc of indexed.documents) {
    const refs = doc.metadata?.evidence_refs;
    if (!Array.isArray(refs)) continue;
    for (const ref of refs) {
      if (typeof ref !== "string") continue;
      if (ref.startsWith("CanonicalTableRow:")) {
        const id = ref.slice("CanonicalTableRow:".length);
        if (!rowIds.has(id)) unresolvedRefs += 1;
      }
      if (ref.startsWith("CanonicalTableDefinition:")) {
        const id = ref.slice("CanonicalTableDefinition:".length);
        if (!defKeys.has(id)) unresolvedRefs += 1;
      }
    }
  }

  writeGeneratedText(
    projectKey,
    "indexes",
    "tables/search_documents.jsonl",
    searchDocumentsToJsonl(indexed.documents),
  );

  const localIndex = buildLocalSearchIndex({
    documents: indexed.documents,
    embeddings: [],
    now,
  });
  writeGeneratedText(
    projectKey,
    "indexes",
    "tables/exact_index.json",
    `${JSON.stringify(localIndex.exact_index)}\n`,
  );
  writeGeneratedText(
    projectKey,
    "indexes",
    "tables/fulltext_index.json",
    `${JSON.stringify(localIndex.fulltext_index)}\n`,
  );
  writeGeneratedText(
    projectKey,
    "indexes",
    "tables/metadata_index.json",
    `${JSON.stringify(localIndex.metadata_index, null, 2)}\n`,
  );
  writeGeneratedText(
    projectKey,
    "indexes",
    "tables/index_manifest.json",
    `${JSON.stringify({ ...localIndex.manifest, table_knowledge_version: TABLE_KNOWLEDGE_VERSION, embeddings: false }, null, 2)}\n`,
  );

  // Smoke fulltext queries (evaluation only — do not affect indexing)
  const smokeQueries = [
    "Welche kundeneigenen Steuertabellen gibt es?",
    "Welche Tabellen beeinflussen Exporte?",
    "Wo werden Werke als Steuerwerte verwendet?",
    "Welche Tabellen enthalten Kunden- oder Partnernummern?",
    "Welche Tabellen werden von mehreren Programmen gelesen?",
    "Welche dynamischen Tabellenzugriffe sind noch offen?",
  ];
  const smoke = smokeQueries.map((q) => {
    const res = searchTablesFulltext({
      query: q,
      documents: indexed.documents,
      index: localIndex,
      limit: 5,
    });
    return {
      query: q,
      top: res.hits.map((h) => ({
        rank: h.rank,
        type: h.knowledge_unit_type,
        title: h.title,
        source_key: h.source_key,
        score: Number(h.combined_score.toFixed(3)),
      })),
    };
  });

  const byType: Record<string, number> = {};
  for (const d of indexed.documents) {
    byType[d.knowledge_unit_type] = (byType[d.knowledge_unit_type] ?? 0) + 1;
  }

  const weakClassification = units.filter(
    (u) =>
      u.category === "unknown" ||
      u.classification === "REVIEW_CANDIDATE" ||
      u.classification_confidence < 0.45,
  ).length;
  const highRelevance = units.filter(
    (u) =>
      u.referenced_by_code ||
      u.classification === "CUSTOMIZING_CONTROL_TABLE" ||
      u.category === "parameter_table" ||
      u.category === "control_table",
  ).length;
  const withoutCode = units.filter((u) => !u.referenced_by_code).length;

  const uniqueIds = new Set(indexed.documents.map((d) => d.search_document_id));
  const uniqueSources = new Set(indexed.documents.map((d) => d.source_key));

  // raw/canonical mtime guard
  const rawUnchanged = rawGuard.every((g) => g.mtime === fileMtime(g.path));

  const report = {
    at: now,
    customer_id: ctx.config.customer_id,
    system_id: systemId,
    table_knowledge_version: TABLE_KNOWLEDGE_VERSION,
    inventory,
    knowledge_units: units.length,
    rule_groups: ruleGroups.length,
    row_evidence: rows.length,
    primary_table_row_documents: primaryRows.length,
    code_table_bindings: bindings.length,
    static_bindings: bindings.filter((b) => b.access_mode === "static").length,
    dynamic_bindings: bindings.filter((b) => b.access_mode === "dynamic").length,
    search_documents_total: indexed.documents.length,
    search_documents_by_type: byType,
    docs_created: indexed.created,
    docs_updated: indexed.updated,
    docs_skipped: indexed.skipped_unchanged,
    weak_or_unknown_classification_tables: weakClassification,
    high_relevance_tables: highRelevance,
    tables_without_code_reference: withoutCode,
    unresolved_evidence_refs: unresolvedRefs,
    validation: {
      unique_search_document_ids: uniqueIds.size === indexed.documents.length,
      unique_source_keys: uniqueSources.size === indexed.documents.length,
      all_rows_preserved: rows.length === bundle.rows.length,
      raw_canonical_mtime_unchanged: rawUnchanged,
      openai_calls: 0,
      openai_cost_usd: 0,
    },
    smoke_fulltext: smoke,
    laufzeit_ms: Date.now() - started,
    outputs: [
      "indexes/tables/table_knowledge_units.jsonl",
      "indexes/tables/table_rule_groups.jsonl",
      "indexes/tables/table_row_evidence.jsonl",
      "indexes/tables/code_table_bindings.jsonl",
      "indexes/tables/search_documents.jsonl",
      "indexes/tables/exact_index.json",
      "indexes/tables/fulltext_index.json",
      "indexes/tables/metadata_index.json",
    ],
  };

  writeGeneratedText(
    projectKey,
    "logs",
    "tables/index_tables_report.json",
    `${JSON.stringify(report, null, 2)}\n`,
  );

  const finished = finalizeManifest({
    ...manifest,
    steps: [
      {
        step_id: "index.tables",
        status: "succeeded",
        started_at: now,
        finished_at: new Date().toISOString(),
        npm_script: "index:tables",
        prompt_versions: {},
        exit_code: 0,
        error: null,
        outputs: report.outputs,
      },
    ],
  });
  writeGeneratedText(
    projectKey,
    "logs",
    `runs/${manifest.run_id}/manifest.json`,
    `${JSON.stringify(finished, null, 2)}\n`,
  );

  console.log("\n=== INDEX TABLES ===");
  console.log(`KnowledgeUnits: ${units.length}`);
  console.log(`RuleGroups: ${ruleGroups.length}`);
  console.log(`RowEvidence: ${rows.length} (primär ${primaryRows.length})`);
  console.log(`Code-Bindings: ${bindings.length}`);
  console.log(`SearchDocuments: ${indexed.documents.length}`);
  console.log(JSON.stringify(byType, null, 2));
  console.log(
    `Docs neu/upd/skip: ${indexed.created}/${indexed.updated}/${indexed.skipped_unchanged}`,
  );
  console.log(`OpenAI: 0`);
  console.log(`Laufzeit ms: ${report.laufzeit_ms}`);
  console.log("\n=== SMOKE FULLTEXT (Top 3) ===");
  for (const s of smoke) {
    console.log(`\nQ: ${s.query}`);
    for (const h of s.top.slice(0, 3)) {
      console.log(
        `  #${h.rank} [${h.score}] ${h.type} | ${h.title.slice(0, 70)}`,
      );
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
