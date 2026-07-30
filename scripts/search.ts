/**
 * Hybrid search CLI (retrieval only — no answer generation).
 *
 *   npm run search -- --customer P01 --system D01 --query "..."
 */
import { existsSync, readFileSync } from "fs";
import { LocalDataError } from "../src/lib/localData/errors";
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

async function main() {
  loadEnvLocal();
  try {
    getLocalDataRoot();
  } catch (error) {
    if (error instanceof LocalDataError) fail(error.message);
    throw error;
  }

  const args = parseCustomerCliArgs(process.argv.slice(2));
  if (!args.query?.trim()) fail("--query ist erforderlich");
  let ctx;
  try {
    ctx = resolveCustomerContext(args);
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e));
  }

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
    fail(
      `SearchDocuments fehlen. Zuerst: npm run index:search -- --customer ${ctx.config.customer_id} --system ${ctx.systemId}`,
    );
  }
  if (!existsSync(embPath)) {
    fail("Embeddings fehlen — zuerst index:search ausführen");
  }

  const documents = [
    ...parseSearchDocumentsJsonl(readFileSync(docsPath, "utf8")).values(),
  ];
  const embeddingsById = parseEmbeddingsJsonl(readFileSync(embPath, "utf8"));
  const index = loadIndex(ctx.projectKey);
  const result = await hybridSearch({
    query: args.query!,
    documents,
    index,
    embeddingsById,
    options: { limit: args.limit ?? 10 },
  });

  console.log(`Query: ${result.query}`);
  console.log(`Treffer: ${result.hits.length}`);
  for (const hit of result.hits) {
    console.log(
      `#${hit.rank} [${hit.combined_score.toFixed(3)}] ${hit.knowledge_unit_type} | ${hit.title}`,
    );
    console.log(
      `  exact=${hit.exact_score.toFixed(2)} ft=${hit.fulltext_score.toFixed(2)} vec=${hit.vector_score.toFixed(3)} rel=${hit.relation_score.toFixed(2)} conf=${hit.confidence}`,
    );
    console.log(`  source_key=${hit.source_key}`);
    console.log(`  snippet=${hit.snippet.slice(0, 160).replace(/\n/g, " ")}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
