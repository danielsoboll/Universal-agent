import { embedQueryText, embeddingVector, type SearchEmbeddingRecord } from "@/lib/search/embedSearchDocuments";
import {
  cosineSimilarity,
  tokenizeSearchText,
  type LocalSearchIndex,
} from "@/lib/search/buildLocalSearchIndex";
import { normalizeSearchToken } from "@/lib/search/buildSearchText";
import type { SearchDocument } from "@/lib/search/searchDocumentSchema";

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
  relation_score: number;
  confidence: number | null;
  matched_terms: string[];
  relation_path: string[];
  evidence_refs: string[];
  snippet: string;
  score_parts: Record<string, number>;
};

export type HybridSearchOptions = {
  limit?: number;
  knowledge_unit_types?: string[];
  expandRelations?: boolean;
  maxHops?: 1 | 2;
};

export type HybridSearchResult = {
  query: string;
  normalized_query: string;
  hits: HybridSearchHit[];
  query_embedding_tokens: number;
  query_embedding_cost: number;
};

function wantsControlLogic(query: string): boolean {
  return /auswirkung|steuerung|sonderlogik|regel|parameter|export|übermittlung|incoterm|werks?liste/i.test(
    query,
  );
}

function wantsDynamicAccess(query: string): boolean {
  return /dynamisch|unresolved|nicht auflös|auflösbar|variable/i.test(query);
}

function evidenceRefsFromDoc(doc: SearchDocument): string[] {
  const meta = doc.metadata?.evidence_refs;
  if (Array.isArray(meta)) {
    return meta.map(String).slice(0, 30);
  }
  const refs: string[] = [];
  for (const e of doc.evidence ?? []) {
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
 * Expand related document ids up to maxHops (cycle-safe).
 */
export function expandRelatedDocuments(params: {
  seedIds: string[];
  index: LocalSearchIndex;
  documentsById: Map<string, SearchDocument>;
  maxHops: number;
}): Map<string, { hops: number; path: string[] }> {
  const out = new Map<string, { hops: number; path: string[] }>();
  const queue: Array<{ id: string; hops: number; path: string[] }> = [];
  for (const id of params.seedIds) {
    out.set(id, { hops: 0, path: [] });
    queue.push({ id, hops: 0, path: [] });
  }

  const byName = new Map<string, string>();
  for (const doc of params.documentsById.values()) {
    byName.set(doc.source_key, doc.search_document_id);
    byName.set(doc.object_name, doc.search_document_id);
    if (doc.subobject_name) byName.set(doc.subobject_name, doc.search_document_id);
    const br = doc.metadata?.business_rule_id;
    if (typeof br === "string") byName.set(br, doc.search_document_id);
    const access = doc.metadata?.access_id;
    if (typeof access === "string") byName.set(access, doc.search_document_id);
  }

  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (cur.hops >= params.maxHops) continue;
    const edges = params.index.relation_index.filter(
      (r) => r.from_id === cur.id,
    );
    for (const edge of edges) {
      const nextId =
        edge.to_id ||
        (edge.to_name ? byName.get(edge.to_name) : undefined);
      if (!nextId || out.has(nextId)) continue;
      const path = [...cur.path, `${edge.relation_type}->${edge.to_name}`];
      out.set(nextId, { hops: cur.hops + 1, path });
      queue.push({ id: nextId, hops: cur.hops + 1, path });
    }
    // Reverse: documents that point to this doc's names
    const seedDoc = params.documentsById.get(cur.id);
    if (!seedDoc) continue;
    const names = new Set(
      [
        seedDoc.source_key,
        seedDoc.object_name,
        seedDoc.subobject_name,
        String(seedDoc.metadata?.business_rule_id ?? ""),
        String(seedDoc.metadata?.access_id ?? ""),
        ...seedDoc.tables_read,
        ...seedDoc.tables_written,
      ].filter(Boolean),
    );
    for (const edge of params.index.relation_index) {
      if (!names.has(edge.to_name)) continue;
      if (out.has(edge.from_id)) continue;
      const path = [
        ...cur.path,
        `REV:${edge.relation_type}<-${edge.to_name}`,
      ];
      out.set(edge.from_id, { hops: cur.hops + 1, path });
      queue.push({ id: edge.from_id, hops: cur.hops + 1, path });
    }
  }
  return out;
}

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
  const maxHops = options.maxHops ?? 2;
  const preferRules = wantsControlLogic(query);
  const preferDynamic = wantsDynamicAccess(query);

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
    relation: number;
    matched: Set<string>;
    path: string[];
  };
  const scores = new Map<string, Acc>();

  const bump = (id: string, patch: Partial<Acc> & { term?: string }) => {
    const cur = scores.get(id) ?? {
      exact: 0,
      fulltext: 0,
      vector: 0,
      relation: 0,
      matched: new Set<string>(),
      path: [],
    };
    if (patch.exact) cur.exact += patch.exact;
    if (patch.fulltext) cur.fulltext += patch.fulltext;
    if (patch.vector) cur.vector = Math.max(cur.vector, patch.vector);
    if (patch.relation) cur.relation += patch.relation;
    if (patch.term) cur.matched.add(patch.term);
    if (patch.path) cur.path = patch.path;
    scores.set(id, cur);
  };

  // 2) exact
  for (const term of exactTerms) {
    for (const id of params.index.exact_index[term] ?? []) {
      bump(id, { exact: 1, term });
    }
  }

  // 3) fulltext
  const N = Math.max(1, params.documents.length);
  for (const term of terms) {
    const postings = params.index.fulltext_index[term] ?? [];
    if (postings.length === 0) continue;
    const idf = Math.log(1 + N / postings.length);
    for (const p of postings) {
      bump(p.id, { fulltext: (1 + Math.log(1 + p.tf)) * idf, term });
    }
  }

  // 4+5) query embedding + vector similarity
  const qEmb = await embedQueryText(query);
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
    if (sim < 0.15) continue;
    bump(row.search_document_id, { vector: sim });
  }

  // Seed top candidates for relation expansion
  const seedIds = [...scores.entries()]
    .map(([id, s]) => ({
      id,
      s: s.exact * 3 + s.fulltext + s.vector * 2,
    }))
    .sort((a, b) => b.s - a.s)
    .slice(0, 12)
    .map((x) => x.id);

  if (options.expandRelations !== false) {
    const expanded = expandRelatedDocuments({
      seedIds,
      index: params.index,
      documentsById,
      maxHops,
    });
    for (const [id, info] of expanded) {
      if (info.hops === 0) continue;
      bump(id, {
        relation: 1 / info.hops,
        path: info.path,
      });
    }
  }

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

    const typeBoost =
      preferDynamic && doc.knowledge_unit_type === "dynamic_table_access"
        ? 2.5
        : preferRules &&
            (doc.knowledge_unit_type === "business_rule" ||
              doc.knowledge_unit_type === "code_table_interpretation")
          ? 1.25
          : 1;
    const factBoost = doc.facts.length > 0 ? 1.1 : 1;
    const conf = doc.confidence ?? 0.5;
    const exact_score = s.exact;
    const fulltext_score = s.fulltext;
    const vector_score = s.vector;
    const relation_score = s.relation;

    const combined_score =
      typeBoost *
      factBoost *
      (exact_score * 4 +
        fulltext_score * 1.2 +
        vector_score * 3 +
        relation_score * 1.5 +
        conf * 0.5);

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
      relation_score,
      confidence: doc.confidence,
      matched_terms: [...s.matched],
      relation_path: s.path,
      evidence_refs: evidenceRefsFromDoc(doc),
      snippet: snippetFromDoc(doc, [...s.matched, ...terms]),
      score_parts: {
        exact: exact_score,
        fulltext: fulltext_score,
        vector: vector_score,
        relation: relation_score,
        confidence: conf,
        type_boost: typeBoost,
        fact_boost: factBoost,
      },
    });
  }

  hits.sort((a, b) => b.combined_score - a.combined_score);
  const limited = hits.slice(0, limit).map((h, i) => ({ ...h, rank: i + 1 }));

  return {
    query,
    normalized_query,
    hits: limited,
    query_embedding_tokens: qEmb.input_tokens,
    query_embedding_cost: qEmb.estimated_cost,
  };
}
