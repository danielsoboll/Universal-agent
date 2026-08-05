/**
 * Classes-only: embed indexes/classes/search_documents.jsonl and merge into
 * hybrid search index without wiping control-table docs.
 *
 *   npx tsx scripts/index-classes-into-hybrid.ts --customer P01 --system D01
 */
import { existsSync, readFileSync } from "fs";
import { replaceClassEntriesInHybridIndex } from "../src/lib/rebuild/mergeHybridIndex";
import { LocalDataError } from "../src/lib/localData/errors";
import {
  ensureWritableDir,
  writeGeneratedText,
} from "../src/lib/localData/fs";
import { resolveWritablePath } from "../src/lib/localData/paths";
import { getLocalDataRoot } from "../src/lib/localData/root";
import {
  loadEnvLocal,
  parseCustomerCliArgs,
  resolveCustomerContext,
} from "../src/lib/search/cliCustomerArgs";
import {
  embedSearchDocuments,
  embeddingsToJsonl,
} from "../src/lib/search/embedSearchDocuments";
import { getEmbeddingRuntimeConfig } from "../src/lib/search/embeddingConfig";
import {
  parseSearchDocumentsJsonl,
  searchDocumentsToJsonl,
} from "../src/lib/search/buildSearchDocuments";
import { isClassHybridDocument } from "../src/lib/rebuild/wipeDerived";

function fail(message: string): never {
  console.error(message);
  process.exit(1);
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
  const now = new Date().toISOString();
  const embCfg = getEmbeddingRuntimeConfig();

  const classDocsPath = resolveWritablePath(
    projectKey,
    "indexes",
    "classes/search_documents.jsonl",
  );
  if (!existsSync(classDocsPath)) {
    fail(
      `Fehlt: ${classDocsPath}. Zuerst npm run index:search-documents ausführen.`,
    );
  }

  const classDocs = [
    ...parseSearchDocumentsJsonl(readFileSync(classDocsPath, "utf8")).values(),
  ].filter((d) => isClassHybridDocument(d));
  if (classDocs.length === 0) {
    fail("Keine Class-SearchDocuments in indexes/classes/search_documents.jsonl.");
  }

  ensureWritableDir(projectKey, "embeddings", "search");
  const classEmbRel = "search/classes_embeddings.jsonl";
  const classEmbPath = resolveWritablePath(projectKey, "embeddings", classEmbRel);
  const existingEmb = existsSync(classEmbPath)
    ? readFileSync(classEmbPath, "utf8")
    : "";

  console.log(
    `Class docs: ${classDocs.length}, Modell=${embCfg.model}, dim=${embCfg.dimensions}`,
  );

  const embedded = await embedSearchDocuments({
    documents: classDocs,
    existingJsonl: existingEmb,
    batchSize: 64,
    now,
    replaceCorpus: true,
    onBatch: (records) => {
      writeGeneratedText(
        projectKey,
        "embeddings",
        classEmbRel,
        embeddingsToJsonl(records),
      );
    },
  });
  writeGeneratedText(
    projectKey,
    "embeddings",
    classEmbRel,
    embeddingsToJsonl(embedded.records),
  );

  const hybrid = replaceClassEntriesInHybridIndex({
    projectKey,
    classDocuments: classDocs,
    classEmbeddings: embedded.records,
    now,
  });

  // Preserve a sidecar copy of class docs used for merge
  writeGeneratedText(
    projectKey,
    "indexes",
    "classes/search_documents.jsonl",
    searchDocumentsToJsonl(classDocs),
  );

  console.log(
    JSON.stringify(
      {
        class_documents: classDocs.length,
        embeddings_neu: embedded.created,
        embeddings_uebersprungen: embedded.skipped_unchanged,
        input_tokens: embedded.input_tokens,
        estimated_cost_usd: embedded.estimated_cost,
        hybrid,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
