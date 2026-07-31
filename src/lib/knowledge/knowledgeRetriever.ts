import { existsSync, readFileSync, statSync } from "fs";
import path from "path";
import { getLocalDataRoot } from "@/lib/localData/root";
import type { LocalProject } from "@/lib/localAuth/types";
import { parseSearchDocumentsJsonl } from "@/lib/search/buildSearchDocuments";
import type { LocalSearchIndex } from "@/lib/search/buildLocalSearchIndex";
import {
  parseEmbeddingsJsonl,
  type SearchEmbeddingRecord,
} from "@/lib/search/embedSearchDocuments";
import type { KnowledgeHit } from "@/lib/knowledge/types";
import { hybridSearch, type HybridSearchHit } from "@/lib/search/hybridSearch";
import type { SearchDocument } from "@/lib/search/searchDocumentSchema";

export type { KnowledgeHit } from "@/lib/knowledge/types";

export type KnowledgeSearchResult = {
  query: string;
  hits: KnowledgeHit[];
  document_count: number;
  vector_search_active: boolean;
  index_path: string;
  query_embedding_tokens: number;
  query_embedding_cost: number;
  warnings: string[];
};

function projectDataRoot(project: LocalProject): string {
  const override = project.local_data_root?.trim();
  if (override) return path.resolve(override);
  return path.join(getLocalDataRoot(), project.customer_id);
}

function resolveIndexDir(project: LocalProject): string {
  const root = projectDataRoot(project);
  const rel = project.active_index_path.replace(/^\/+/, "") || "indexes/search";
  return path.join(root, rel);
}

function loadLocalIndex(indexDir: string): LocalSearchIndex {
  const readJson = (name: string) =>
    JSON.parse(readFileSync(path.join(indexDir, name), "utf8"));
  const vectorPath = path.join(indexDir, "vector_index.jsonl");
  const vector_index = existsSync(vectorPath)
    ? readFileSync(vectorPath, "utf8")
        .split(/\r?\n/)
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l))
    : [];
  return {
    exact_index: existsSync(path.join(indexDir, "exact_index.json"))
      ? readJson("exact_index.json")
      : {},
    fulltext_index: existsSync(path.join(indexDir, "fulltext_index.json"))
      ? readJson("fulltext_index.json")
      : {},
    metadata_index: existsSync(path.join(indexDir, "metadata_index.json"))
      ? readJson("metadata_index.json")
      : {},
    relation_index: existsSync(path.join(indexDir, "relation_index.json"))
      ? readJson("relation_index.json")
      : {},
    vector_index,
    manifest: existsSync(path.join(indexDir, "index_manifest.json"))
      ? readJson("index_manifest.json")
      : {
          at: "",
          document_count: 0,
          embedding_count: 0,
          embedding_model: "",
          embedding_version: "",
          dimensions: 0,
          content_fingerprint: "",
        },
  };
}

export function inspectProjectKnowledge(project: LocalProject): {
  ok: boolean;
  data_root: string;
  index_dir: string;
  docs_path: string;
  document_count: number;
  has_embeddings: boolean;
  vector_index_entries: number;
  message: string;
} {
  const data_root = projectDataRoot(project);
  const index_dir = resolveIndexDir(project);
  const docs_path = path.join(index_dir, "search_documents.jsonl");
  if (!existsSync(data_root)) {
    return {
      ok: false,
      data_root,
      index_dir,
      docs_path,
      document_count: 0,
      has_embeddings: false,
      vector_index_entries: 0,
      message: `Datenverzeichnis fehlt: ${data_root}`,
    };
  }
  if (!existsSync(docs_path)) {
    return {
      ok: false,
      data_root,
      index_dir,
      docs_path,
      document_count: 0,
      has_embeddings: false,
      vector_index_entries: 0,
      message: `SearchDocuments fehlen unter ${docs_path}`,
    };
  }
  const documents = [
    ...parseSearchDocumentsJsonl(readFileSync(docs_path, "utf8")).values(),
  ];
  const embPath = path.join(
    data_root,
    "embeddings",
    "search",
    "search_embeddings.jsonl",
  );
  const has_embeddings = existsSync(embPath) && statSync(embPath).size > 0;
  const index = loadLocalIndex(index_dir);
  return {
    ok: documents.length > 0,
    data_root,
    index_dir,
    docs_path,
    document_count: documents.length,
    has_embeddings,
    vector_index_entries: index.vector_index.length,
    message:
      documents.length > 0
        ? `${documents.length} SearchDocuments, Embeddings: ${has_embeddings ? "ja" : "nein"}`
        : "Index ist leer",
  };
}

function enrichHits(
  hits: HybridSearchHit[],
  documentsById: Map<string, SearchDocument>,
): KnowledgeHit[] {
  return hits.map((h) => {
    const doc = documentsById.get(h.search_document_id);
    return {
      ...h,
      facts: doc?.facts ?? [],
      inferences: doc?.inferences ?? [],
      metadata: (doc?.metadata as Record<string, unknown>) ?? {},
      object_name: doc?.object_name ?? "",
      object_type: doc?.object_type ?? "",
      subobject_name: doc?.subobject_name ?? "",
      technical_summary: doc?.technical_summary ?? "",
      business_purpose: doc?.business_purpose ?? "",
    };
  });
}

export async function knowledgeSearch(params: {
  project: LocalProject;
  query: string;
  limit?: number;
  filters?: { knowledge_unit_types?: string[] };
}): Promise<KnowledgeSearchResult> {
  const warnings: string[] = [];
  const status = inspectProjectKnowledge(params.project);
  if (!status.ok) {
    throw new Error(status.message);
  }

  const documents = [
    ...parseSearchDocumentsJsonl(readFileSync(status.docs_path, "utf8")).values(),
  ];
  const documentsById = new Map(
    documents.map((d) => [d.search_document_id, d]),
  );
  const index = loadLocalIndex(status.index_dir);

  let embeddingsById = new Map<string, SearchEmbeddingRecord>();
  const embPath = path.join(
    status.data_root,
    "embeddings",
    "search",
    "search_embeddings.jsonl",
  );
  if (existsSync(embPath)) {
    embeddingsById = parseEmbeddingsJsonl(readFileSync(embPath, "utf8"));
  } else {
    warnings.push("Embeddings fehlen — nur exakte/Volltext-/Metadatensuche.");
  }

  const types =
    params.filters?.knowledge_unit_types?.length
      ? params.filters.knowledge_unit_types
      : params.project.enabled_knowledge_unit_types.length
        ? params.project.enabled_knowledge_unit_types
        : undefined;

  const enableVector =
    embeddingsById.size > 0 && Boolean(process.env.OPENAI_API_KEY?.trim());
  if (!enableVector && embeddingsById.size > 0) {
    warnings.push("OPENAI_API_KEY fehlt — Vector Search deaktiviert.");
  }

  const result = await hybridSearch({
    query: params.query,
    documents,
    index,
    embeddingsById,
    options: {
      limit: params.limit ?? 8,
      knowledge_unit_types: types,
      enableVector,
    },
  });

  return {
    query: result.query,
    hits: enrichHits(result.hits, documentsById),
    document_count: documents.length,
    vector_search_active: enableVector && result.hits.some((h) => h.vector_score > 0),
    index_path: status.index_dir,
    query_embedding_tokens: result.query_embedding_tokens,
    query_embedding_cost: result.query_embedding_cost,
    warnings,
  };
}

export const KnowledgeRetriever = {
  search: knowledgeSearch,
  inspect: inspectProjectKnowledge,
};
