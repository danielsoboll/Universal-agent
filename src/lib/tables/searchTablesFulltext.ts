import {
  tokenizeSearchText,
  type LocalSearchIndex,
} from "@/lib/search/buildLocalSearchIndex";
import { normalizeSearchToken } from "@/lib/search/buildSearchText";
import type { SearchDocument } from "@/lib/search/searchDocumentSchema";

export type TableFulltextHit = {
  rank: number;
  search_document_id: string;
  source_key: string;
  title: string;
  knowledge_unit_type: string;
  exact_score: number;
  fulltext_score: number;
  metadata_score: number;
  combined_score: number;
  matched_terms: string[];
  snippet: string;
  evidence_refs: string[];
};

/**
 * Deterministic exact + fulltext + metadata search (no embeddings).
 */
export function searchTablesFulltext(params: {
  query: string;
  documents: SearchDocument[];
  index: LocalSearchIndex;
  limit?: number;
}): { query: string; hits: TableFulltextHit[] } {
  const query = params.query.trim();
  const limit = params.limit ?? 10;
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

  type Acc = { exact: number; fulltext: number; meta: number; matched: Set<string> };
  const scores = new Map<string, Acc>();
  const bump = (id: string, patch: Partial<Acc> & { term?: string }) => {
    const cur = scores.get(id) ?? {
      exact: 0,
      fulltext: 0,
      meta: 0,
      matched: new Set<string>(),
    };
    if (patch.exact) cur.exact += patch.exact;
    if (patch.fulltext) cur.fulltext += patch.fulltext;
    if (patch.meta) cur.meta += patch.meta;
    if (patch.term) cur.matched.add(patch.term);
    scores.set(id, cur);
  };

  for (const term of exactTerms) {
    for (const id of params.index.exact_index[term] ?? []) {
      bump(id, { exact: 1, term });
    }
  }

  const N = Math.max(1, params.documents.length);
  for (const term of terms) {
    const postings = params.index.fulltext_index[term] ?? [];
    if (!postings.length) continue;
    const idf = Math.log(1 + N / postings.length);
    for (const p of postings) {
      bump(p.id, { fulltext: (1 + Math.log(1 + p.tf)) * idf, term });
    }
  }

  // Simple metadata: type / object_name token overlap
  for (const [id, meta] of Object.entries(params.index.metadata_index)) {
    let metaScore = 0;
    const hay = `${meta.knowledge_unit_type} ${meta.object_name} ${meta.title} ${meta.source_key}`.toLowerCase();
    for (const t of terms) {
      if (hay.includes(t)) metaScore += 0.5;
    }
    if (metaScore > 0) bump(id, { meta: metaScore });
  }

  const hits: TableFulltextHit[] = [];
  for (const [id, s] of scores) {
    const doc = documentsById.get(id);
    if (!doc) continue;
    const combined =
      s.exact * 4 + s.fulltext * 1.2 + s.meta * 1.0 + (doc.confidence ?? 0.5) * 0.3;
    const refs = Array.isArray(doc.metadata?.evidence_refs)
      ? (doc.metadata!.evidence_refs as string[]).slice(0, 8)
      : [];
    const hay = doc.search_text || doc.title;
    const lower = hay.toLowerCase();
    let idx = -1;
    for (const t of s.matched) {
      const i = lower.indexOf(t.toLowerCase());
      if (i >= 0) {
        idx = i;
        break;
      }
    }
    const snippet =
      idx < 0 ? hay.slice(0, 200) : hay.slice(Math.max(0, idx - 40), idx + 200);
    hits.push({
      rank: 0,
      search_document_id: id,
      source_key: doc.source_key,
      title: doc.title,
      knowledge_unit_type: doc.knowledge_unit_type,
      exact_score: s.exact,
      fulltext_score: s.fulltext,
      metadata_score: s.meta,
      combined_score: combined,
      matched_terms: [...s.matched],
      snippet,
      evidence_refs: refs,
    });
  }

  hits.sort((a, b) => b.combined_score - a.combined_score);
  return {
    query,
    hits: hits.slice(0, limit).map((h, i) => ({ ...h, rank: i + 1 })),
  };
}
