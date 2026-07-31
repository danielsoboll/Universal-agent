import {
  embedQueryText,
  embeddingVector,
  type SearchEmbeddingRecord,
} from "@/lib/search/embedSearchDocuments";
import {
  cosineSimilarity,
  tokenizeSearchText,
  type LocalSearchIndex,
} from "@/lib/search/buildLocalSearchIndex";
import { normalizeSearchToken } from "@/lib/search/buildSearchText";
import type { SearchDocument } from "@/lib/search/searchDocumentSchema";

/** Fixed generic weights — not tuned to evaluation questions. */
const W_EXACT = 4;
const W_FULLTEXT = 1.2;
const W_VECTOR = 3;
const W_CONFIDENCE = 0.5;
/** Minimum cosine similarity to count as a vector hit. */
const VECTOR_MIN = 0.15;

export type HybridSearchHit = {
  rank: number;
  search_document_id: string;
  source_key: string;
  title: string;
  knowledge_unit_type: string;
  combined_score: number;
  exact_score: number;
  fulltext_score: number;
  vector_score: number;
  confidence_bonus: number;
  confidence: number | null;
  matched_terms: string[];
  snippet: string;
  evidence_refs: string[];
};

export type HybridSearchOptions = {
  limit?: number;
  knowledge_unit_types?: string[];
  /** When false, skip query embedding / vector scoring (lexical only). */
  enableVector?: boolean;
};

export type HybridSearchResult = {
  query: string;
  normalized_query: string;
  hits: HybridSearchHit[];
  query_embedding_tokens: number;
  query_embedding_cost: number;
};

function evidenceRefsFromDoc(doc: SearchDocument): string[] {
  const meta = doc.metadata?.evidence_refs;
  if (Array.isArray(meta)) {
    return meta.map(String).slice(0, 30);
  }
  const refs: string[] = [];
  for (const e of doc.evidence ?? []) {
    if (e.text) refs.push(e.text);
    for (const line of e.lines ?? []) {
      if (line.quote) refs.push(line.quote);
      if (line.line) refs.push(`L${line.line}`);
    }
  }
  return refs.slice(0, 30);
}

function snippetFromDoc(doc: SearchDocument, terms: string[]): string {
  const hay = doc.search_text || doc.title;
  const lower = hay.toLowerCase();
  let idx = -1;
  for (const t of terms) {
    const i = lower.indexOf(t.toLowerCase());
    if (i >= 0) {
      idx = i;
      break;
    }
  }
  if (idx < 0) return hay.slice(0, 220);
  const start = Math.max(0, idx - 60);
  return hay.slice(start, start + 240);
}

/**
 * Minimal hybrid retrieval: exact + normalized fulltext + vector + confidence.
 * No relation expansion, no query-intent type boosting, no eval special cases.
 */
export async function hybridSearch(params: {
  query: string;
  documents: SearchDocument[];
  index: LocalSearchIndex;
  embeddingsById: Map<string, SearchEmbeddingRecord>;
  options?: HybridSearchOptions;
}): Promise<HybridSearchResult> {
  const query = params.query.trim();
  const normalized_query = normalizeSearchToken(query).toLowerCase();
  const options = params.options ?? {};
  const limit = options.limit ?? 10;

  const documentsById = new Map(
    params.documents.map((d) => [d.search_document_id, d]),
  );
  const terms = tokenizeSearchText(query);
  const exactTerms = [
    ...new Set(
      query
        .split(/[\s,;|]+/)
        .map((t) => normalizeSearchToken(t).toUpperCase())
        .filter((t) => t.length >= 2),
    ),
  ];

  type Acc = {
    exact: number;
    fulltext: number;
    vector: number;
    matched: Set<string>;
  };
  const scores = new Map<string, Acc>();

  const bump = (id: string, patch: Partial<Acc> & { term?: string }) => {
    const cur = scores.get(id) ?? {
      exact: 0,
      fulltext: 0,
      vector: 0,
      matched: new Set<string>(),
    };
    if (patch.exact) cur.exact += patch.exact;
    if (patch.fulltext) cur.fulltext += patch.fulltext;
    if (patch.vector) cur.vector = Math.max(cur.vector, patch.vector);
    if (patch.term) cur.matched.add(patch.term);
    scores.set(id, cur);
  };

  // 1) exact term → exact_index
  for (const term of exactTerms) {
    for (const id of params.index.exact_index[term] ?? []) {
      bump(id, { exact: 1, term });
    }
  }

  // 2) normalized fulltext (tf-idf-ish)
  const N = Math.max(1, params.documents.length);
  for (const term of terms) {
    const postings = params.index.fulltext_index[term] ?? [];
    if (postings.length === 0) continue;
    const idf = Math.log(1 + N / postings.length);
    for (const p of postings) {
      bump(p.id, { fulltext: (1 + Math.log(1 + p.tf)) * idf, term });
    }
  }

  // 3) query embedding + cosine similarity (optional)
  let query_embedding_tokens = 0;
  let query_embedding_cost = 0;
  const enableVector = options.enableVector !== false;
  if (enableVector && params.embeddingsById.size > 0) {
    try {
      const qEmb = await embedQueryText(query);
      query_embedding_tokens = qEmb.input_tokens;
      query_embedding_cost = qEmb.estimated_cost;
      for (const row of params.index.vector_index) {
        const emb = params.embeddingsById.get(row.search_document_id);
        if (!emb) continue;
        let vector: number[];
        try {
          vector = embeddingVector(emb);
        } catch {
          continue;
        }
        const sim = cosineSimilarity(qEmb.vector, vector);
        if (sim < VECTOR_MIN) continue;
        bump(row.search_document_id, { vector: sim });
      }
    } catch (error) {
      console.warn(
        "[hybridSearch] Vector search übersprungen:",
        error instanceof Error ? error.message : error,
      );
    }
  }

  // 4) simple metadata weighting = confidence_bonus only
  const hits: HybridSearchHit[] = [];
  for (const [id, s] of scores) {
    const doc = documentsById.get(id);
    if (!doc) continue;
    if (
      options.knowledge_unit_types &&
      !options.knowledge_unit_types.includes(doc.knowledge_unit_type)
    ) {
      continue;
    }

    const conf = doc.confidence ?? 0.5;
    const exact_score = s.exact;
    const fulltext_score = s.fulltext;
    const vector_score = s.vector;
    const confidence_bonus = conf * W_CONFIDENCE;
    const combined_score =
      exact_score * W_EXACT +
      fulltext_score * W_FULLTEXT +
      vector_score * W_VECTOR +
      confidence_bonus;

    hits.push({
      rank: 0,
      search_document_id: id,
      source_key: doc.source_key,
      title: doc.title,
      knowledge_unit_type: doc.knowledge_unit_type,
      combined_score,
      exact_score,
      fulltext_score,
      vector_score,
      confidence_bonus,
      confidence: doc.confidence,
      matched_terms: [...s.matched],
      snippet: snippetFromDoc(doc, [...s.matched, ...terms]),
      evidence_refs: evidenceRefsFromDoc(doc),
    });
  }

  hits.sort((a, b) => b.combined_score - a.combined_score);
  const limited = hits.slice(0, limit).map((h, i) => ({ ...h, rank: i + 1 }));

  return {
    query,
    normalized_query,
    hits: limited,
    query_embedding_tokens,
    query_embedding_cost,
  };
}
