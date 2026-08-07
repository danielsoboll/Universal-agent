import type { LocalProject } from "@/lib/localAuth/types";
import type { DomainSearchProfile } from "@/lib/domain/types";
import { resolveProjectCapabilities } from "@/lib/domain/capabilities";
import type { SearchEmbeddingRecord } from "@/lib/search/embedSearchDocuments";
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
import { askPerfNote } from "@/lib/knowledge/askPerf";
import {
  getProjectEmbeddings,
  getProjectSearchBundle,
} from "@/lib/knowledge/projectKnowledgeCache";
import {
  isPortableIndexReady,
  loadPortableManifest,
} from "@/lib/portableIndex/indexLoader";
import { searchViaAccessIndexes } from "@/lib/portableIndex/accessIndexSearch";
import { namedEntityTechnicalAnchors } from "@/lib/knowledge/searchBudget/extractNamedExternalEntity";
import { existsSync } from "fs";

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
  /** Access-index path diagnostics (when used). */
  access_index?: {
    primary_path: string;
    indexes_used: string[];
    literal_miss: boolean;
    graph_used: boolean;
    legacy_used: boolean;
  };
};

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
  try {
    const bundle = getProjectSearchBundle(project);
    if (!existsSync(bundle.data_root)) {
      console.error(
        "[KnowledgeRetriever.inspect] Datenverzeichnis fehlt:",
        bundle.data_root,
      );
      return {
        ok: false,
        data_root: bundle.data_root,
        index_dir: bundle.index_dir,
        docs_path: bundle.docs_path,
        document_count: 0,
        has_embeddings: false,
        vector_index_entries: 0,
        message: "Projekt nicht konfiguriert",
      };
    }

    const projectKey = project.customer_id?.trim() || BOUND_DATA_PROJECT_KEY || "P01";
    if (bundle.access_index_mode || isPortableIndexReady(projectKey)) {
      const manifest = loadPortableManifest(projectKey);
      const count =
        manifest?.counts.evidence_documents ??
        manifest?.counts.symbols ??
        0;
      askPerfNote(
        `inspectProjectKnowledge: ACCESS_INDEX mode (${count} evidence refs, portable ready)`,
      );
      return {
        ok: count > 0,
        data_root: bundle.data_root,
        index_dir: bundle.index_dir,
        docs_path: bundle.docs_path,
        document_count: count,
        has_embeddings: bundle.has_embeddings_file,
        vector_index_entries: 0,
        message:
          count > 0
            ? `Access Indices bereit (${count} Evidence-Refs), Embeddings: ${bundle.has_embeddings_file ? "ja (lazy)" : "nein"}`
            : "Access Indices leer",
      };
    }

    if (!existsSync(bundle.docs_path)) {
      console.error(
        "[KnowledgeRetriever.inspect] SearchDocuments fehlen:",
        bundle.docs_path,
      );
      return {
        ok: false,
        data_root: bundle.data_root,
        index_dir: bundle.index_dir,
        docs_path: bundle.docs_path,
        document_count: 0,
        has_embeddings: bundle.has_embeddings_file,
        vector_index_entries: bundle.index.vector_index.length,
        message: "Wissensindex fehlt",
      };
    }
    askPerfNote(
      `inspectProjectKnowledge: bundle ${bundle.from_cache ? "cache HIT" : "loaded"} (${bundle.documents.length} docs)`,
    );
    return {
      ok: bundle.documents.length > 0,
      data_root: bundle.data_root,
      index_dir: bundle.index_dir,
      docs_path: bundle.docs_path,
      document_count: bundle.documents.length,
      has_embeddings: bundle.has_embeddings_file,
      vector_index_entries: bundle.index.vector_index.length,
      message:
        bundle.documents.length > 0
          ? `${bundle.documents.length} SearchDocuments, Embeddings: ${bundle.has_embeddings_file ? "ja" : "nein"}`
          : "Wissensindex leer",
    };
  } catch (error) {
    console.error(
      "[KnowledgeRetriever.inspect] fehlgeschlagen:",
      error instanceof Error ? error.message : error,
    );
    return {
      ok: false,
      data_root: "",
      index_dir: "",
      docs_path: "",
      document_count: 0,
      has_embeddings: false,
      vector_index_entries: 0,
      message: "Projekt nicht konfiguriert",
    };
  }
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
  /**
   * Override vector/embedding search. When false → LOCAL_EXACT / lexical only
   * (no OpenAI embedding call). When omitted, enabled if key + embeddings exist.
   */
  enableVector?: boolean;
  /** When omitted, resolved from project.domain_profile_id. */
  searchProfile?: DomainSearchProfile;
}): Promise<KnowledgeSearchResult> {
  const warnings: string[] = [];
  const bundle = getProjectSearchBundle(params.project);
  const limit = params.limit ?? 40;

  // --- Primary: portable Access Indices (no legacy full load) ---
  if (bundle.access_index_mode) {
    const access = searchViaAccessIndexes({
      project: params.project,
      query: params.query,
      limit,
    });
    if (access) {
      if (access.literal_miss) {
        return {
          query: params.query,
          hits: [],
          document_count: access.document_count,
          vector_search_active: false,
          index_path: bundle.index_dir,
          query_embedding_tokens: 0,
          query_embedding_cost: 0,
          warnings: [
            ...access.warnings,
            "SEARCH_BUDGET: Vector Search übersprungen (Literal-Index ohne Treffer).",
          ],
          access_index: {
            primary_path: access.primary_path,
            indexes_used: access.indexes_used,
            literal_miss: true,
            graph_used: false,
            legacy_used: false,
          },
          lexical_diagnosis: access.lexical_diagnosis,
          lexical_expansion_tokens: access.lexical_expansion_tokens,
        };
      }

      const vectorRequested = params.enableVector === true;
      const hasTechnicalAnchor = namedEntityTechnicalAnchors(
        params.query,
      ).length > 0;
      const strongExact =
        hasTechnicalAnchor &&
        access.hits.some(
          (h) =>
            h.knowledge_unit_type === "message_idoc_object" ||
            h.knowledge_unit_type === "master_field" ||
            h.exact_score >= 3 ||
            (h.matched_terms ?? []).some((t) => String(t).startsWith("sym:")),
        );

      // Exact/literal/relation with technical anchors: return access hits.
      // Semantic Stage-1 (no technical anchor): allow vector even if soft lexical hits exist.
      if (!vectorRequested || (access.hits.length > 0 && strongExact)) {
        if (!vectorRequested) {
          warnings.push(
            "SEARCH_BUDGET: Vector Search übersprungen (ACCESS_INDEX / LOCAL_EXACT).",
          );
          askPerfNote("embeddings skipped (enableVector=false, access-index)");
        } else {
          askPerfNote(
            "embeddings skipped (strong access exact hits — no vector needed)",
          );
        }
        return {
          query: params.query,
          hits: access.hits,
          document_count: Math.max(
            access.document_count,
            access.evidence_fetched,
          ),
          vector_search_active: false,
          index_path: bundle.index_dir,
          query_embedding_tokens: 0,
          query_embedding_cost: 0,
          warnings: [...warnings, ...access.warnings],
          access_index: {
            primary_path: access.primary_path,
            indexes_used: access.indexes_used,
            literal_miss: false,
            graph_used: access.graph_used,
            legacy_used: false,
          },
          lexical_diagnosis: access.lexical_diagnosis,
          lexical_expansion_tokens: access.lexical_expansion_tokens,
        };
      }

      if (vectorRequested) {
        askPerfNote(
          hasTechnicalAnchor
            ? "access indexes weak — semantic vector path (lazy embeddings)"
            : "semantic query without technical anchor — vector path (lazy embeddings)",
        );
        warnings.push(...access.warnings);
        // fall through to vector below
      }
    }
  }

  if (bundle.documents.length === 0 && !bundle.access_index_mode) {
    throw new Error(
      existsSync(bundle.docs_path) ? "Wissensindex leer" : "Wissensindex fehlt",
    );
  }

  // Access mode with semantic vector request and no exact hits: need documents for vector
  // → lazy-load portable evidence maps only when vector is truly needed
  let documents = bundle.documents;
  let documentsById = bundle.documentsById;
  let index = bundle.index;

  if (bundle.access_index_mode && documents.length === 0) {
    const projectKey =
      params.project.customer_id?.trim() ||
      BOUND_DATA_PROJECT_KEY ||
      "P01";
    if (params.enableVector === true && bundle.has_embeddings_file) {
      const { loadPortableEvidenceMaps } = await import(
        "@/lib/portableIndex/indexLoader"
      );
      const maps = loadPortableEvidenceMaps(projectKey);
      if (maps) {
        documents = [...maps.byId.values()];
        documentsById = maps.byId;
        askPerfNote(
          `semantic fallback: loaded portable evidence for vector (${documents.length})`,
        );
        // Still no legacy fulltext — vector uses vector_index from embeddings path
        // Load thin vector_index from legacy only if needed for id list
        warnings.push(
          "ACCESS_INDEX: semantischer Fallback — Evidence für Vector geladen (kein Legacy-Fulltext).",
        );
      }
    }
    if (documents.length === 0) {
      return {
        query: params.query,
        hits: [],
        document_count: 0,
        vector_search_active: false,
        index_path: bundle.index_dir,
        query_embedding_tokens: 0,
        query_embedding_cost: 0,
        warnings: [
          ...warnings,
          "ACCESS_INDEX: keine Treffer und kein Vector-Korpus.",
        ],
      };
    }
  }

  const capabilities = resolveProjectCapabilities(params.project);
  const searchProfile = params.searchProfile ?? capabilities.searchProfile;

  // Embeddings: only load when vector mode is actually requested
  let embeddingsById = new Map<string, SearchEmbeddingRecord>();
  const vectorRequested = params.enableVector === true;
  if (!vectorRequested) {
    warnings.push("SEARCH_BUDGET: Vector Search übersprungen (LOCAL_EXACT).");
    askPerfNote("embeddings skipped (enableVector=false)");
  } else if (!bundle.has_embeddings_file) {
    warnings.push("Embeddings fehlen — nur exakte/Volltext-/Metadatensuche.");
  } else {
    embeddingsById = getProjectEmbeddings(params.project);
    if (embeddingsById.size === 0) {
      warnings.push("Embeddings fehlen — nur exakte/Volltext-/Metadatensuche.");
    }
  }

  const types =
    params.filters?.knowledge_unit_types?.length
      ? params.filters.knowledge_unit_types
      : params.project.enabled_knowledge_unit_types.length
        ? params.project.enabled_knowledge_unit_types
        : undefined;

  const canVector =
    embeddingsById.size > 0 && Boolean(process.env.OPENAI_API_KEY?.trim());
  const enableVector = vectorRequested ? canVector : false;
  if (vectorRequested && !enableVector && embeddingsById.size > 0) {
    warnings.push("OPENAI_API_KEY fehlt — Vector Search deaktiviert.");
  }

  const relationDefault = searchProfile.defaultRelationExpansion;
  const enableRelationExpansion =
    params.enableRelationExpansion !== undefined
      ? params.enableRelationExpansion
      : relationDefault;

  // For vector-only semantic fallback without legacy index, synthesize vector_index from embeddings keys
  if (enableVector && index.vector_index.length === 0 && embeddingsById.size > 0) {
    index = {
      ...index,
      vector_index: [...embeddingsById.keys()].map((search_document_id) => {
        const emb = embeddingsById.get(search_document_id);
        return {
          search_document_id,
          source_key: emb?.source_key ?? search_document_id,
          content_hash: emb?.content_hash ?? "",
          dimensions: emb?.dimensions ?? 0,
        };
      }),
    };
  }

  const result = await hybridSearch({
    query: params.query,
    documents,
    index,
    embeddingsById,
    options: {
      limit: Math.max(limit * 2, 48),
      knowledge_unit_types: types,
      enableVector,
      enableRelationExpansion,
      metadata_filters: params.filters?.metadata_filters,
      knowledgeUnitTypeBoosts: searchProfile.knowledgeUnitTypeBoosts,
    },
  });

  const hybridHits = enrichHits(result.hits, documentsById);

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
    index_path: bundle.index_dir,
    query_embedding_tokens: result.query_embedding_tokens,
    query_embedding_cost: result.query_embedding_cost,
    warnings,
    lexical_diagnosis,
    lexical_expansion_tokens,
    access_index: bundle.access_index_mode
      ? {
          primary_path: "semantic-vector-fallback",
          indexes_used: ["lexical-index", "vector/embeddings"],
          literal_miss: false,
          graph_used: false,
          legacy_used: false,
        }
      : {
          primary_path: "legacy-hybrid",
          indexes_used: ["legacy-search-shards"],
          literal_miss: false,
          graph_used: false,
          legacy_used: true,
        },
  };
}

export const KnowledgeRetriever = {
  search: knowledgeSearch,
  inspect: inspectProjectKnowledge,
};
