/**
 * Evaluate hybrid search against fixed question catalog.
 *
 *   npm run evaluate:search -- --customer P01 --system D01
 */
import { existsSync, readFileSync } from "fs";
import path from "path";
import { LocalDataError } from "../src/lib/localData/errors";
import { writeGeneratedText } from "../src/lib/localData/fs";
import { resolveWritablePath } from "../src/lib/localData/paths";
import { getLocalDataRoot } from "../src/lib/localData/root";
import { parseSearchDocumentsJsonl } from "../src/lib/search/buildSearchDocuments";
import type { LocalSearchIndex } from "../src/lib/search/buildLocalSearchIndex";
import {
  loadEnvLocal,
  parseCustomerCliArgs,
  resolveCustomerContext,
} from "../src/lib/search/cliCustomerArgs";
import { parseEmbeddingsJsonl } from "../src/lib/search/embedSearchDocuments";
import { hybridSearch } from "../src/lib/search/hybridSearch";

type EvalQuestion = {
  id: string;
  query: string;
  expected_source_keys: string[];
  expected_knowledge_unit_types: string[];
  expected_terms: string[];
  forbidden_claims: string[];
  minimum_recall: number;
  require_type_hit?: boolean;
  require_fact_inference_markers?: boolean;
  notes?: string;
};

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function loadIndex(projectKey: string): LocalSearchIndex {
  const read = (rel: string) =>
    readFileSync(resolveWritablePath(projectKey, "indexes", rel), "utf8");
  const vectorPath = resolveWritablePath(
    projectKey,
    "indexes",
    "search/vector_index.jsonl",
  );
  const vector_index = existsSync(vectorPath)
    ? readFileSync(vectorPath, "utf8")
        .split(/\r?\n/)
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l))
    : [];
  return {
    exact_index: JSON.parse(read("search/exact_index.json")),
    fulltext_index: JSON.parse(read("search/fulltext_index.json")),
    metadata_index: JSON.parse(read("search/metadata_index.json")),
    relation_index: JSON.parse(read("search/relation_index.json")),
    vector_index,
    manifest: JSON.parse(read("search/index_manifest.json")),
  };
}

function recall(expected: string[], got: string[]): number {
  if (expected.length === 0) return 1;
  const set = new Set(got);
  const hit = expected.filter((e) =>
    [...set].some((g) => g === e || g.includes(e) || e.includes(g)),
  ).length;
  return hit / expected.length;
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

  const catalogPath = path.resolve(
    process.cwd(),
    "tests/evaluation/hybrid-search-questions.json",
  );
  const questions = JSON.parse(
    readFileSync(catalogPath, "utf8"),
  ) as EvalQuestion[];

  const docsPath = resolveWritablePath(
    ctx.projectKey,
    "indexes",
    "search/search_documents.jsonl",
  );
  const embPath = resolveWritablePath(
    ctx.projectKey,
    "embeddings",
    "search/search_embeddings.jsonl",
  );
  if (!existsSync(docsPath)) {
    fail("SearchDocuments fehlen — zuerst index:search ausführen");
  }
  if (!existsSync(embPath)) {
    fail("Embeddings fehlen — zuerst index:search ausführen");
  }
  const documents = [
    ...parseSearchDocumentsJsonl(readFileSync(docsPath, "utf8")).values(),
  ];
  const embeddingsById = parseEmbeddingsJsonl(readFileSync(embPath, "utf8"));
  const index = loadIndex(ctx.projectKey);

  const results = [];
  let tokens = 0;
  let cost = 0;
  const weak: string[] = [];

  for (const q of questions) {
    const search = await hybridSearch({
      query: q.query,
      documents,
      index,
      embeddingsById,
      options: { limit: 10 },
    });
    tokens += search.query_embedding_tokens;
    cost += search.query_embedding_cost;

    const topKeys = search.hits.map((h) => h.source_key);
    const topTypes = search.hits.map((h) => h.knowledge_unit_type);
    const r = recall(q.expected_source_keys, topKeys);
    const typeHit =
      !q.require_type_hit ||
      q.expected_knowledge_unit_types.some((t) => topTypes.includes(t));
    const blob = search.hits
      .map((h) => `${h.title}\n${h.snippet}\n${h.evidence_refs.join("\n")}`)
      .join("\n")
      .toUpperCase();
    const termHits = q.expected_terms.filter((t) =>
      blob.includes(t.toUpperCase()),
    );
    const factInfOk =
      !q.require_fact_inference_markers ||
      (blob.includes("FACT") && blob.includes("INFERENCE"));

    const pass =
      r >= q.minimum_recall && typeHit && factInfOk && termHits.length > 0
        ? true
        : q.expected_source_keys.length === 0 && typeHit && factInfOk
          ? termHits.length > 0 || q.minimum_recall === 0
          : r >= q.minimum_recall && typeHit;

    if (!pass || q.id === "q1") weak.push(q.id);

    results.push({
      id: q.id,
      query: q.query,
      recall: Number(r.toFixed(3)),
      minimum_recall: q.minimum_recall,
      pass,
      type_hit: typeHit,
      term_hits: termHits,
      top5: search.hits.slice(0, 5).map((h) => ({
        rank: h.rank,
        title: h.title,
        knowledge_unit_type: h.knowledge_unit_type,
        source_key: h.source_key,
        combined_score: Number(h.combined_score.toFixed(4)),
        exact_score: h.exact_score,
        fulltext_score: Number(h.fulltext_score.toFixed(3)),
        vector_score: Number(h.vector_score.toFixed(3)),
        relation_score: h.relation_score,
      })),
      notes: q.notes ?? null,
    });

    console.log(
      `${q.id} recall=${r.toFixed(2)} pass=${pass} | ${q.query.slice(0, 60)}`,
    );
  }

  const report = {
    at: new Date().toISOString(),
    customer_id: ctx.config.customer_id,
    system_id: ctx.systemId,
    questions: results.length,
    passed: results.filter((r) => r.pass).length,
    weak_or_failed: weak,
    query_embedding_tokens: tokens,
    query_embedding_cost_usd: Number(cost.toFixed(6)),
    results,
  };

  writeGeneratedText(
    ctx.projectKey,
    "logs",
    "search/evaluate_search_report.json",
    `${JSON.stringify(report, null, 2)}\n`,
  );

  console.log("\n=== EVALUATE SEARCH ===");
  console.log(`passed ${report.passed}/${report.questions}`);
  console.log(`weak/failed: ${weak.join(", ") || "—"}`);
  console.log(`query embed tokens/cost: ${tokens} / $${report.query_embedding_cost_usd}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
