/**
 * Deterministic fulltext/metadata search over table knowledge corpus.
 *
 *   npm run search:tables -- --customer P01 --system D01 --query "..."
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
import { searchTablesFulltext } from "../src/lib/tables/searchTablesFulltext";

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function loadIndex(projectKey: string): LocalSearchIndex {
  const read = (rel: string) =>
    readFileSync(resolveWritablePath(projectKey, "indexes", rel), "utf8");
  return {
    exact_index: JSON.parse(read("tables/exact_index.json")),
    fulltext_index: JSON.parse(read("tables/fulltext_index.json")),
    metadata_index: JSON.parse(read("tables/metadata_index.json")),
    relation_index: [],
    vector_index: [],
    manifest: JSON.parse(read("tables/index_manifest.json")),
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
    "tables/search_documents.jsonl",
  );
  if (!existsSync(docsPath)) {
    fail(
      `Tabellen-SearchDocuments fehlen. Zuerst: npm run index:tables -- --customer ${ctx.config.customer_id} --system ${ctx.systemId}`,
    );
  }

  const documents = [
    ...parseSearchDocumentsJsonl(readFileSync(docsPath, "utf8")).values(),
  ];
  const index = loadIndex(ctx.projectKey);
  const result = searchTablesFulltext({
    query: args.query!,
    documents,
    index,
    limit: args.limit ?? 10,
  });

  console.log(`Query: ${result.query}`);
  console.log(`Treffer: ${result.hits.length}`);
  for (const hit of result.hits) {
    console.log(
      `#${hit.rank} [${hit.combined_score.toFixed(3)}] ${hit.knowledge_unit_type} | ${hit.title}`,
    );
    console.log(
      `  exact=${hit.exact_score.toFixed(2)} ft=${hit.fulltext_score.toFixed(2)} meta=${hit.metadata_score.toFixed(2)}`,
    );
    console.log(`  source_key=${hit.source_key}`);
    console.log(`  snippet=${hit.snippet.slice(0, 180).replace(/\n/g, " ")}`);
    if (hit.evidence_refs.length) {
      console.log(`  evidence=${hit.evidence_refs.slice(0, 3).join(" | ")}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
