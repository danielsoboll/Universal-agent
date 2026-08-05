import { existsSync, readFileSync } from "fs";
import {
  ensureWritableDir,
  writeGeneratedText,
} from "@/lib/localData/fs";
import { resolveWritablePath } from "@/lib/localData/paths";
import { buildLocalSearchIndex } from "@/lib/search/buildLocalSearchIndex";
import {
  parseSearchDocumentsJsonl,
  searchDocumentsToJsonl,
} from "@/lib/search/buildSearchDocuments";
import {
  embeddingsToJsonl,
  parseEmbeddingsJsonl,
  type SearchEmbeddingRecord,
} from "@/lib/search/embedSearchDocuments";
import type { SearchDocument } from "@/lib/search/searchDocumentSchema";
import {
  isClassHybridDocument,
  isControlTableHybridDocument,
} from "@/lib/rebuild/wipeDerived";

/**
 * Replace control-table entries in the hybrid search index only.
 * Code / other types remain untouched. No candidate/approval/rollback folders.
 */
export function replaceControlTableEntriesInHybridIndex(params: {
  projectKey: string;
  tableDocuments: SearchDocument[];
  tableEmbeddings: SearchEmbeddingRecord[];
  now: string;
}): {
  kept_other_documents: number;
  removed_control_table_documents: number;
  added_control_table_documents: number;
  total_documents: number;
  total_embeddings: number;
  index_entries: number;
} {
  const projectKey = params.projectKey;
  ensureWritableDir(projectKey, "indexes", "search");
  ensureWritableDir(projectKey, "embeddings", "search");

  const docsPath = resolveWritablePath(
    projectKey,
    "indexes",
    "search/search_documents.jsonl",
  );
  const embPath = resolveWritablePath(
    projectKey,
    "embeddings",
    "search/search_embeddings.jsonl",
  );

  const existingDocs = existsSync(docsPath)
    ? [...parseSearchDocumentsJsonl(readFileSync(docsPath, "utf8")).values()]
    : [];
  const kept = existingDocs.filter((d) => !isControlTableHybridDocument(d));
  const removed = existingDocs.length - kept.length;

  // Prefer table overview / rows / groupings for hybrid; skip code bindings
  // to avoid duplicating existing interpretation docs from analyses.
  const toAdd = params.tableDocuments.filter((d) =>
    ["table_profile", "table_row", "table_rule_group", "business_rule"].includes(
      d.knowledge_unit_type,
    ),
  );
  const mergedDocs = [...kept, ...toAdd].sort((a, b) =>
    a.search_document_id.localeCompare(b.search_document_id),
  );
  const keepIds = new Set(mergedDocs.map((d) => d.search_document_id));

  const existingEmb = existsSync(embPath)
    ? [...parseEmbeddingsJsonl(readFileSync(embPath, "utf8")).values()]
    : [];
  const keptEmb = existingEmb.filter(
    (e) =>
      keepIds.has(e.search_document_id) &&
      !toAdd.some((d) => d.search_document_id === e.search_document_id),
  );
  const addEmbIds = new Set(toAdd.map((d) => d.search_document_id));
  const addEmb = params.tableEmbeddings.filter((e) =>
    addEmbIds.has(e.search_document_id),
  );
  const mergedEmb = [...keptEmb, ...addEmb].sort((a, b) =>
    a.search_document_id.localeCompare(b.search_document_id),
  );

  writeGeneratedText(
    projectKey,
    "indexes",
    "search/search_documents.jsonl",
    searchDocumentsToJsonl(mergedDocs),
  );
  writeGeneratedText(
    projectKey,
    "embeddings",
    "search/search_embeddings.jsonl",
    embeddingsToJsonl(mergedEmb),
  );

  const localIndex = buildLocalSearchIndex({
    documents: mergedDocs,
    embeddings: mergedEmb,
    now: params.now,
  });

  writeGeneratedText(
    projectKey,
    "indexes",
    "search/exact_index.json",
    `${JSON.stringify(localIndex.exact_index)}\n`,
  );
  writeGeneratedText(
    projectKey,
    "indexes",
    "search/fulltext_index.json",
    `${JSON.stringify(localIndex.fulltext_index)}\n`,
  );
  writeGeneratedText(
    projectKey,
    "indexes",
    "search/metadata_index.json",
    `${JSON.stringify(localIndex.metadata_index, null, 2)}\n`,
  );
  writeGeneratedText(
    projectKey,
    "indexes",
    "search/relation_index.json",
    `${JSON.stringify(localIndex.relation_index, null, 2)}\n`,
  );
  writeGeneratedText(
    projectKey,
    "indexes",
    "search/vector_index.jsonl",
    localIndex.vector_index.length
      ? `${localIndex.vector_index.map((r) => JSON.stringify(r)).join("\n")}\n`
      : "",
  );
  writeGeneratedText(
    projectKey,
    "indexes",
    "search/index_manifest.json",
    `${JSON.stringify(localIndex.manifest, null, 2)}\n`,
  );

  const index_entries =
    Object.keys(localIndex.exact_index).length +
    Object.keys(localIndex.fulltext_index).length +
    Object.keys(localIndex.metadata_index).length +
    localIndex.vector_index.length;

  return {
    kept_other_documents: kept.length,
    removed_control_table_documents: removed,
    added_control_table_documents: toAdd.length,
    total_documents: mergedDocs.length,
    total_embeddings: mergedEmb.length,
    index_entries,
  };
}

/**
 * Replace class / code-unit entries in the hybrid search index only.
 * Control-table and other non-class docs/embeddings stay. Never touches raw/.
 */
export function replaceClassEntriesInHybridIndex(params: {
  projectKey: string;
  classDocuments: SearchDocument[];
  classEmbeddings: SearchEmbeddingRecord[];
  now: string;
}): {
  kept_other_documents: number;
  removed_class_documents: number;
  added_class_documents: number;
  total_documents: number;
  total_embeddings: number;
  index_entries: number;
} {
  const projectKey = params.projectKey;
  ensureWritableDir(projectKey, "indexes", "search");
  ensureWritableDir(projectKey, "embeddings", "search");

  const docsPath = resolveWritablePath(
    projectKey,
    "indexes",
    "search/search_documents.jsonl",
  );
  const embPath = resolveWritablePath(
    projectKey,
    "embeddings",
    "search/search_embeddings.jsonl",
  );

  const existingDocs = existsSync(docsPath)
    ? [...parseSearchDocumentsJsonl(readFileSync(docsPath, "utf8")).values()]
    : [];
  const kept = existingDocs.filter((d) => !isClassHybridDocument(d));
  const removed = existingDocs.length - kept.length;

  const toAdd = params.classDocuments.filter((d) => isClassHybridDocument(d));
  const mergedDocs = [...kept, ...toAdd].sort((a, b) =>
    a.search_document_id.localeCompare(b.search_document_id),
  );
  const keepIds = new Set(mergedDocs.map((d) => d.search_document_id));

  const existingEmb = existsSync(embPath)
    ? [...parseEmbeddingsJsonl(readFileSync(embPath, "utf8")).values()]
    : [];
  const keptEmb = existingEmb.filter(
    (e) =>
      keepIds.has(e.search_document_id) &&
      !toAdd.some((d) => d.search_document_id === e.search_document_id),
  );
  const addEmbIds = new Set(toAdd.map((d) => d.search_document_id));
  const addEmb = params.classEmbeddings.filter((e) =>
    addEmbIds.has(e.search_document_id),
  );
  const mergedEmb = [...keptEmb, ...addEmb].sort((a, b) =>
    a.search_document_id.localeCompare(b.search_document_id),
  );

  writeGeneratedText(
    projectKey,
    "indexes",
    "search/search_documents.jsonl",
    searchDocumentsToJsonl(mergedDocs),
  );
  writeGeneratedText(
    projectKey,
    "embeddings",
    "search/search_embeddings.jsonl",
    embeddingsToJsonl(mergedEmb),
  );

  const localIndex = buildLocalSearchIndex({
    documents: mergedDocs,
    embeddings: mergedEmb,
    now: params.now,
  });

  writeGeneratedText(
    projectKey,
    "indexes",
    "search/exact_index.json",
    `${JSON.stringify(localIndex.exact_index)}\n`,
  );
  writeGeneratedText(
    projectKey,
    "indexes",
    "search/fulltext_index.json",
    `${JSON.stringify(localIndex.fulltext_index)}\n`,
  );
  writeGeneratedText(
    projectKey,
    "indexes",
    "search/metadata_index.json",
    `${JSON.stringify(localIndex.metadata_index, null, 2)}\n`,
  );
  writeGeneratedText(
    projectKey,
    "indexes",
    "search/relation_index.json",
    `${JSON.stringify(localIndex.relation_index, null, 2)}\n`,
  );
  writeGeneratedText(
    projectKey,
    "indexes",
    "search/vector_index.jsonl",
    localIndex.vector_index.length
      ? `${localIndex.vector_index.map((r) => JSON.stringify(r)).join("\n")}\n`
      : "",
  );
  writeGeneratedText(
    projectKey,
    "indexes",
    "search/index_manifest.json",
    `${JSON.stringify(localIndex.manifest, null, 2)}\n`,
  );

  const index_entries =
    Object.keys(localIndex.exact_index).length +
    Object.keys(localIndex.fulltext_index).length +
    Object.keys(localIndex.metadata_index).length +
    localIndex.vector_index.length;

  return {
    kept_other_documents: kept.length,
    removed_class_documents: removed,
    added_class_documents: toAdd.length,
    total_documents: mergedDocs.length,
    total_embeddings: mergedEmb.length,
    index_entries,
  };
}

/**
 * Remove classes / code-unit entries from the hybrid search index.
 * Control-table and other non-class docs/embeddings stay. Never touches raw/.
 */
export function removeClassEntriesFromHybridIndex(params: {
  projectKey: string;
  now?: string;
}): {
  kept_documents: number;
  removed_class_documents: number;
  total_embeddings: number;
  index_entries: number;
} {
  const projectKey = params.projectKey;
  const now = params.now ?? new Date().toISOString();
  ensureWritableDir(projectKey, "indexes", "search");
  ensureWritableDir(projectKey, "embeddings", "search");

  const docsPath = resolveWritablePath(
    projectKey,
    "indexes",
    "search/search_documents.jsonl",
  );
  const embPath = resolveWritablePath(
    projectKey,
    "embeddings",
    "search/search_embeddings.jsonl",
  );

  const existingDocs = existsSync(docsPath)
    ? [...parseSearchDocumentsJsonl(readFileSync(docsPath, "utf8")).values()]
    : [];
  const kept = existingDocs.filter((d) => !isClassHybridDocument(d));
  const removed = existingDocs.length - kept.length;
  const keepIds = new Set(kept.map((d) => d.search_document_id));

  const existingEmb = existsSync(embPath)
    ? [...parseEmbeddingsJsonl(readFileSync(embPath, "utf8")).values()]
    : [];
  const keptEmb = existingEmb.filter((e) => keepIds.has(e.search_document_id));

  writeGeneratedText(
    projectKey,
    "indexes",
    "search/search_documents.jsonl",
    searchDocumentsToJsonl(kept),
  );
  writeGeneratedText(
    projectKey,
    "embeddings",
    "search/search_embeddings.jsonl",
    embeddingsToJsonl(keptEmb),
  );

  const localIndex = buildLocalSearchIndex({
    documents: kept,
    embeddings: keptEmb,
    now,
  });

  writeGeneratedText(
    projectKey,
    "indexes",
    "search/exact_index.json",
    `${JSON.stringify(localIndex.exact_index)}\n`,
  );
  writeGeneratedText(
    projectKey,
    "indexes",
    "search/fulltext_index.json",
    `${JSON.stringify(localIndex.fulltext_index)}\n`,
  );
  writeGeneratedText(
    projectKey,
    "indexes",
    "search/metadata_index.json",
    `${JSON.stringify(localIndex.metadata_index, null, 2)}\n`,
  );
  writeGeneratedText(
    projectKey,
    "indexes",
    "search/relation_index.json",
    `${JSON.stringify(localIndex.relation_index, null, 2)}\n`,
  );
  writeGeneratedText(
    projectKey,
    "indexes",
    "search/vector_index.jsonl",
    localIndex.vector_index.length
      ? `${localIndex.vector_index.map((r) => JSON.stringify(r)).join("\n")}\n`
      : "",
  );
  writeGeneratedText(
    projectKey,
    "indexes",
    "search/index_manifest.json",
    `${JSON.stringify(localIndex.manifest, null, 2)}\n`,
  );

  const index_entries =
    Object.keys(localIndex.exact_index).length +
    Object.keys(localIndex.fulltext_index).length +
    Object.keys(localIndex.metadata_index).length +
    localIndex.vector_index.length;

  return {
    kept_documents: kept.length,
    removed_class_documents: removed,
    total_embeddings: keptEmb.length,
    index_entries,
  };
}
