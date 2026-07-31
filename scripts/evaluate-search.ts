/**
 * Evaluate hybrid search — evaluation only; never feeds ranking.
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
import { hybridSearch, type HybridSearchHit } from "../src/lib/search/hybridSearch";

type RelevanceHints = {
  source_key_substrings?: string[];
  title_substrings?: string[];
  types?: string[];
};

type EvalQuestion = {
  id: string;
  query: string;
  relevance_hints?: RelevanceHints;
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

/** Soft relevance for reporting only — not used by hybridSearch. */
function isRelevantHit(hit: HybridSearchHit, hints?: RelevanceHints): boolean {
  if (!hints) return false;
  const blob = `${hit.source_key}\n${hit.title}\n${hit.snippet}`.toLowerCase();

  // Prefer explicit type gate when only dynamic_table_access is requested
  const types = hints.types ?? [];
  if (types.length === 1 && types[0] === "dynamic_table_access") {
    return (
      hit.knowledge_unit_type === "dynamic_table_access" ||
      hit.source_key.startsWith("dynamic:")
    );
  }

  for (const s of hints.source_key_substrings ?? []) {
    if (s.length >= 4 && hit.source_key.toLowerCase().includes(s.toLowerCase())) {
      return true;
    }
  }
  for (const s of hints.title_substrings ?? []) {
    if (s.length >= 4 && blob.includes(s.toLowerCase())) return true;
  }
  return false;
}

function firstRelevantRank(hits: HybridSearchHit[], hints?: RelevanceHints): number | null {
  for (const h of hits) {
    if (isRelevantHit(h, hints)) return h.rank;
  }
  return null;
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

    const relevantRank = firstRelevantRank(search.hits, q.relevance_hints);
    const inTop3 = relevantRank != null && relevantRank <= 3;
    const inTop5 = relevantRank != null && relevantRank <= 5;
    const inTop10 = relevantRank != null && relevantRank <= 10;
    if (!inTop5) weak.push(q.id);

    const top10 = search.hits.map((h) => ({
      rank: h.rank,
      title: h.title,
      knowledge_unit_type: h.knowledge_unit_type,
      source_key: h.source_key,
      combined_score: Number(h.combined_score.toFixed(4)),
      exact_score: h.exact_score,
      fulltext_score: Number(h.fulltext_score.toFixed(3)),
      vector_score: Number(h.vector_score.toFixed(3)),
      confidence_bonus: Number(h.confidence_bonus.toFixed(3)),
      confidence: h.confidence,
      matched_terms: h.matched_terms,
      evidence_refs: h.evidence_refs.slice(0, 5),
      snippet: h.snippet.slice(0, 160),
      soft_relevant: isRelevantHit(h, q.relevance_hints),
    }));

    results.push({
      id: q.id,
      query: q.query,
      relevant_rank: relevantRank,
      in_top3: inTop3,
      in_top5: inTop5,
      in_top10: inTop10,
      top10,
      notes: q.notes ?? null,
    });

    console.log(`\n=== ${q.id}: ${q.query}`);
    console.log(
      `relevant@rank=${relevantRank ?? "—"} | top3=${inTop3} top5=${inTop5} top10=${inTop10}`,
    );
    for (const h of top10) {
      console.log(
        `  #${h.rank} [${h.combined_score}] ${h.knowledge_unit_type} | ${h.title.slice(0, 70)}${h.soft_relevant ? " ★" : ""}`,
      );
      console.log(
        `      exact=${h.exact_score} ft=${h.fulltext_score} vec=${h.vector_score} conf_b=${h.confidence_bonus}`,
      );
      console.log(`      source=${h.source_key}`);
    }
  }

  const report = {
    at: new Date().toISOString(),
    customer_id: ctx.config.customer_id,
    system_id: ctx.systemId,
    questions: results.length,
    weak_questions: weak,
    in_top3: results.filter((r) => r.in_top3).length,
    in_top5: results.filter((r) => r.in_top5).length,
    in_top10: results.filter((r) => r.in_top10).length,
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
  console.log(`top3/top5/top10: ${report.in_top3}/${report.in_top5}/${report.in_top10} of ${report.questions}`);
  console.log(`weak: ${weak.join(", ") || "—"}`);
  console.log(`query embed tokens/cost: ${tokens} / $${report.query_embedding_cost_usd}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
