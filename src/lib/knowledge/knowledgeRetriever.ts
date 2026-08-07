import { existsSync, readFileSync, statSync } from "fs";
import path from "path";
import { getLocalDataRoot } from "@/lib/localData/root";
import type { LocalProject } from "@/lib/localAuth/types";
import type { DomainSearchProfile } from "@/lib/domain/types";
import { resolveProjectCapabilities } from "@/lib/domain/capabilities";
import { parseSearchDocumentsJsonl } from "@/lib/search/buildSearchDocuments";
import type { LocalSearchIndex } from "@/lib/search/buildLocalSearchIndex";
import {
  parseEmbeddingsJsonl,
  type SearchEmbeddingRecord,
} from "@/lib/search/embedSearchDocuments";
import type { KnowledgeHit } from "@/lib/knowledge/types";
import { hybridSearch, type HybridSearchHit } from "@/lib/search/hybridSearch";
import type { SearchDocument } from "@/lib/search/searchDocumentSchema";
import { getLexicalCorpusCached } from "@/lib/search/lexical/corpusCache";
import { runLexicalSearch } from "@/lib/search/lexical/runLexicalSearch";
import { mergeLexicalIntoHybridHits } from "@/lib/search/lexical/mergeLexicalIntoHybrid";
import { expandCodeUsagesFromCanonical } from "@/lib/search/lexical/expandCodeUsages";
import { normalizeLexicalQuery } from "@/lib/search/lexical/normalizeQuery";
import { selectUsefulHits } from "@/lib/knowledge/richEvidence";
import type { LexicalSearchDiagnosis } from "@/lib/search/lexical/types";
import { BOUND_DATA_PROJECT_KEY } from "@/lib/localData/boundProject";

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
  /** Lexical DDIC/object diagnosis (same service as multi-source stage). */
  lexical_diagnosis?: LexicalSearchDiagnosis;
  /** Tokens from lexical primary anchors for relation expansion. */
  lexical_expansion_tokens?: string[];
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
    console.error(
      "[KnowledgeRetriever.inspect] Datenverzeichnis fehlt:",
      data_root,
    );
    return {
      ok: false,
      data_root,
      index_dir,
      docs_path,
      document_count: 0,
      has_embeddings: false,
      vector_index_entries: 0,
      message: "Projekt nicht konfiguriert",
    };
  }
  if (!existsSync(docs_path)) {
    console.error(
      "[KnowledgeRetriever.inspect] SearchDocuments fehlen:",
      docs_path,
    );
    return {
      ok: false,
      data_root,
      index_dir,
      docs_path,
      document_count: 0,
      has_embeddings: false,
      vector_index_entries: 0,
      message: "Wissensindex fehlt",
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
        : "Wissensindex leer",
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
      tables_read: doc?.tables_read ?? [],
      tables_written: doc?.tables_written ?? [],
      called_methods: doc?.called_methods ?? [],
      called_functions: doc?.called_functions ?? [],
      hardcoded_values: doc?.hardcoded_values ?? [],
      entities: doc?.entities ?? [],
      relations: doc?.relations ?? [],
      evidence: doc?.evidence ?? [],
      doc_confidence: doc?.confidence ?? null,
    };
  });
}

export async function knowledgeSearch(params: {
  project: LocalProject;
  query: string;
  limit?: number;
  filters?: {
    knowledge_unit_types?: string[];
    metadata_filters?: Record<string, unknown>;
  };
  enableRelationExpansion?: boolean;
  /** When omitted, resolved from project.domain_profile_id. */
  searchProfile?: DomainSearchProfile;
}): Promise<KnowledgeSearchResult> {
  const warnings: string[] = [];
  const status = inspectProjectKnowledge(params.project);
  if (!status.ok) {
    throw new Error(status.message);
  }

  const capabilities = resolveProjectCapabilities(params.project);
  const searchProfile = params.searchProfile ?? capabilities.searchProfile;

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

  const relationDefault = searchProfile.defaultRelationExpansion;
  const enableRelationExpansion =
    params.enableRelationExpansion !== undefined
      ? params.enableRelationExpansion
      : relationDefault;

  const limit = params.limit ?? 40;
  const result = await hybridSearch({
    query: params.query,
    documents,
    index,
    embeddingsById,
    options: {
      // Fetch extra hybrid hits so lexical merge can prepend without starving diversity
      limit: Math.max(limit * 2, 48),
      knowledge_unit_types: types,
      enableVector,
      enableRelationExpansion,
      metadata_filters: params.filters?.metadata_filters,
      knowledgeUnitTypeBoosts: searchProfile.knowledgeUnitTypeBoosts,
    },
  });

  const hybridHits = enrichHits(result.hits, documentsById);

  // Same lexical DDIC/object service as multi-source — Direct Search must use it too
  const projectKey =
    params.project.customer_id?.trim() ||
    BOUND_DATA_PROJECT_KEY ||
    "P01";
  let lexical_diagnosis: LexicalSearchDiagnosis | undefined;
  let lexical_expansion_tokens: string[] | undefined;
  let hits = hybridHits;
  try {
    const corpus = getLexicalCorpusCached(projectKey);
    const lex = runLexicalSearch({
      question: params.query,
      documents: corpus,
      limit: 60,
    });
    lexical_diagnosis = lex.diagnosis;
    const merged = mergeLexicalIntoHybridHits({
      hybridHits,
      lexicalHits: lex.hits,
      documents,
      limit: Math.max(limit, 36),
    });
    hits = merged.hits;
    lexical_expansion_tokens = merged.expansion_tokens;

    // Canonical code-usage expansion from primary field/table tokens
    if (merged.expansion_tokens.length > 0) {
      const seen = new Set(hits.map((h) => h.source_key).filter(Boolean));
      const stems = normalizeLexicalQuery(params.query).stems;
      const codeHits = expandCodeUsagesFromCanonical({
        projectKey,
        tokens: merged.expansion_tokens,
        contentStems: stems,
        limit: 24,
        alreadySeen: seen,
      });
      if (codeHits.length > 0) {
        // Keep lexical primary field/profile hits first; then best code; then rest
        const primary = hits.filter(
          (h) =>
            h.knowledge_unit_type === "master_field" ||
            ((h.matched_terms ?? []).some(
              (t) =>
                String(t).startsWith("phrase:") ||
                String(t).startsWith("lexical:exact_phrase"),
            ) &&
              (h.knowledge_unit_type === "table_profile" ||
                h.knowledge_unit_type === "control_table")),
        );
        const primaryIds = new Set(primary.map((h) => h.search_document_id));
        const rest = hits.filter((h) => !primaryIds.has(h.search_document_id));
        hits = [...primary, ...codeHits, ...rest]
          .slice(0, Math.max(limit, 48))
          .map((h, i) => ({ ...h, rank: i + 1 }));
        warnings.push(
          `Code-Expansion: ${codeHits.length} Canonical-Treffer zu [${merged.expansion_tokens.slice(0, 4).join(", ")}]`,
        );
      }
    }

    // Drop low-usefulness noise (IDOCs etc.) when strong lexical anchors exist
    if ((lexical_diagnosis?.selected_primary_anchors?.length ?? 0) > 0) {
      hits = selectUsefulHits(hits, Math.max(limit, 40));
    }

    if (merged.promoted > 0) {
      warnings.push(
        `Lexikalische DDIC-Suche: ${merged.promoted} Phrase-/Feldtreffer priorisiert`,
      );
    }
  } catch (err) {
    warnings.push(
      `Lexikalische Suche übersprungen: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  return {
    query: result.query,
    hits,
    document_count: documents.length,
    vector_search_active: enableVector,
    index_path: status.index_dir,
    query_embedding_tokens: result.query_embedding_tokens,
    query_embedding_cost: result.query_embedding_cost,
    warnings,
    lexical_diagnosis,
    lexical_expansion_tokens,
  };
}

export const KnowledgeRetriever = {
  search: knowledgeSearch,
  inspect: inspectProjectKnowledge,
};
