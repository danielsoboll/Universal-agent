import {
  embedQueryText,
  embeddingVector,
  type SearchEmbeddingRecord,
} from "@/lib/search/embedSearchDocuments";
import {
  cosineSimilarity,
  expandSearchTokenVariants,
  foldSearchDiacritics,
  tokenizeSearchText,
  type LocalSearchIndex,
} from "@/lib/search/buildLocalSearchIndex";
import { normalizeSearchToken } from "@/lib/search/buildSearchText";
import type { SearchDocument } from "@/lib/search/searchDocumentSchema";
import {
  documentSymbolHaystack,
  extractTechnicalSymbols,
  haystackMatchesSymbol,
} from "@/lib/search/technicalSymbols";
import { isQueryStopword as sharedIsQueryStopword } from "@/lib/knowledge/queryStopwords";
import { normalizeLexicalQuery } from "@/lib/search/lexical/normalizeQuery";

/** Fixed generic weights — not tuned to evaluation questions. */
const W_EXACT = 4;
const W_FULLTEXT = 1.2;
const W_VECTOR = 3;
const W_METADATA = 1.0;
const W_CONFIDENCE = 0.5;
/** Exact multi-word phrase in field/title/purpose — strong lexical signal. */
const W_PHRASE = 18;
/** All content stems present in one document. */
const W_ALL_TERMS = 8;
/** Soft penalty for generic table profiles when stronger field hits exist. */
const TABLE_PROFILE_SOFT_PENALTY = 6;
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
  metadata_score: number;
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
  /** When false, skip 1-hop relation expansion. Default true. */
  enableRelationExpansion?: boolean;
  /** Exact match on SearchDocument.metadata keys (string/number/boolean). */
  metadata_filters?: Record<string, unknown>;
  /** Domain search profile type boosts (additive on combined score). */
  knowledgeUnitTypeBoosts?: Record<string, number>;
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

function isQueryStopword(term: string): boolean {
  const t = foldSearchDiacritics(term.toLowerCase());
  return sharedIsQueryStopword(t) || sharedIsQueryStopword(term.toLowerCase());
}

/**
 * Lexical query terms after compound expansion, without DE/EN function words.
 */
export function lexicalQueryTerms(query: string): string[] {
  return [...new Set(tokenizeSearchText(query).filter((t) => !isQueryStopword(t)))];
}

/**
 * Exact lookup keys: surface tokens + compound/diacritic variants (uppercased).
 */
export function exactQueryTerms(query: string): string[] {
  const out = new Set<string>();
  for (const raw of query.split(/[\s,;|]+/)) {
    const surface = normalizeSearchToken(raw);
    if (surface.length < 2) continue;
    for (const v of expandSearchTokenVariants(surface)) {
      if (isQueryStopword(v)) continue;
      out.add(v.toUpperCase());
    }
  }
  return [...out];
}

/**
 * Minimal hybrid retrieval: exact + normalized fulltext + vector + metadata + confidence.
 * No query-intent type boosting, no eval / customer special cases.
 * Optional single 1-hop relation expansion via relation_index (generic).
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
  const lexQ = normalizeLexicalQuery(query);
  const terms = [
    ...new Set([
      ...lexicalQueryTerms(query),
      ...lexQ.stems,
      ...lexQ.content_terms.filter((t) => t.length >= 3),
    ]),
  ];
  const exactTerms = exactQueryTerms(query);
  const technicalSymbols = extractTechnicalSymbols(query);
  const symbolNeedles = technicalSymbols.map((s) => s.norm);
  const phrases = lexQ.phrases.filter(
    (p) => p.length >= 5 && p.split(/\s+/).length >= 2,
  );
  const contentStems = lexQ.stems.filter((t) => t.length >= 3);

  type Acc = {
    exact: number;
    fulltext: number;
    vector: number;
    meta: number;
    matched: Set<string>;
    /** Forced technical symbol hit — must not be dropped by type filters. */
    symbol_forced: boolean;
  };
  const scores = new Map<string, Acc>();

  const bump = (
    id: string,
    patch: Partial<Acc> & { term?: string; symbol_forced?: boolean },
  ) => {
    const cur = scores.get(id) ?? {
      exact: 0,
      fulltext: 0,
      vector: 0,
      meta: 0,
      matched: new Set<string>(),
      symbol_forced: false,
    };
    if (patch.exact) cur.exact += patch.exact;
    if (patch.fulltext) cur.fulltext += patch.fulltext;
    if (patch.vector) cur.vector = Math.max(cur.vector, patch.vector);
    if (patch.meta) cur.meta += patch.meta;
    if (patch.term) cur.matched.add(patch.term);
    if (patch.symbol_forced) cur.symbol_forced = true;
    scores.set(id, cur);
  };

  // 0) Global exact / substring symbol search BEFORE semantic scoring.
  // Technical hits must survive even if knowledge_unit_type filters disagree.
  if (symbolNeedles.length > 0) {
    for (const doc of params.documents) {
      const hay = documentSymbolHaystack(doc);
      let matched = 0;
      for (const needle of symbolNeedles) {
        if (haystackMatchesSymbol(hay, needle)) {
          matched += 1;
          bump(doc.search_document_id, {
            exact: needle.length >= 6 ? 3 : 2,
            term: `sym:${needle}`,
            symbol_forced: true,
          });
        }
      }
      if (matched === 0) continue;
    }
  }

  // 1) exact term → exact_index
  for (const term of exactTerms) {
    for (const id of params.index.exact_index[term] ?? []) {
      bump(id, { exact: 1, term });
    }
  }

  // 2) normalized fulltext (tf-idf-ish), stopwords already removed from terms
  const N = Math.max(1, params.documents.length);
  for (const term of terms) {
    const postings = params.index.fulltext_index[term] ?? [];
    if (postings.length === 0) continue;
    const idf = Math.log(1 + N / postings.length);
    for (const p of postings) {
      bump(p.id, { fulltext: (1 + Math.log(1 + p.tf)) * idf, term });
    }
  }

  // 2b) Exact phrase + all-content-stems over title/purpose/field text (generic)
  const foldHay = (s: string) => foldSearchDiacritics(s.toLowerCase());
  for (const doc of params.documents) {
    const purpose = foldHay(doc.business_purpose ?? "");
    const title = foldHay(doc.title ?? "");
    const fieldText = foldHay(
      String(
        doc.metadata?.field_text ??
          doc.metadata?.description ??
          "",
      ),
    );
    const search = foldHay(doc.search_text ?? "");
    const descBlob = `${purpose} ${title} ${fieldText}`.trim();
    for (const phrase of phrases) {
      const p = foldHay(phrase);
      if (p.length < 5) continue;
      const inDesc = descBlob.includes(p);
      const inSearch =
        doc.knowledge_unit_type === "master_field" && search.includes(p);
      if (!inDesc && !inSearch) continue;
      // Field/purpose phrases outweigh bare search_text profile matches
      bump(doc.search_document_id, {
        exact: inDesc ? 4 : 2,
        fulltext: inDesc ? W_PHRASE / W_FULLTEXT : W_PHRASE / (W_FULLTEXT * 2),
        term: `phrase:${phrase}`,
      });
      break;
    }
    if (contentStems.length >= 2) {
      const blob = `${descBlob} ${search}`;
      if (contentStems.every((t) => blob.includes(foldHay(t)))) {
        bump(doc.search_document_id, {
          meta: W_ALL_TERMS / W_METADATA,
          term: "all_terms",
        });
      }
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

  // 4) metadata: title / object / type token overlap (same idea as table fulltext)
  for (const [id, meta] of Object.entries(params.index.metadata_index)) {
    let metaScore = 0;
    const hay =
      `${meta.knowledge_unit_type} ${meta.object_name} ${meta.subobject_name} ${meta.title} ${meta.source_key}`.toLowerCase();
    const hayTokens = new Set(tokenizeSearchText(hay));
    for (const t of terms) {
      if (hayTokens.has(t) || hay.includes(t)) metaScore += 0.5;
    }
    if (metaScore > 0) bump(id, { meta: metaScore });
  }

  // 5) generic 1-hop relation expansion — only from current top seeds (no chain)
  if (options.enableRelationExpansion !== false) {
    const REL_EXPAND_SEEDS = 5;
    const unitNameToId = new Map<string, string>();
    for (const doc of params.documents) {
      const unit = doc.subobject_name?.trim();
      if (unit && !unitNameToId.has(unit.toUpperCase())) {
        unitNameToId.set(unit.toUpperCase(), doc.search_document_id);
      }
    }
    const rankedSeeds = [...scores.entries()]
      .map(([id, s]) => ({
        id,
        pre:
          s.exact * W_EXACT +
          s.fulltext * W_FULLTEXT +
          s.vector * W_VECTOR +
          s.meta * W_METADATA,
      }))
      .sort((a, b) => b.pre - a.pre)
      .slice(0, REL_EXPAND_SEEDS);
    for (const seed of rankedSeeds) {
      for (const rel of params.index.relation_index) {
        if (rel.from_id !== seed.id) continue;
        const toId =
          rel.to_id ||
          (rel.to_name
            ? unitNameToId.get(rel.to_name.toUpperCase())
            : undefined);
        if (!toId || toId === seed.id) continue;
        bump(toId, {
          fulltext: Math.min(2.5, Math.max(0.8, seed.pre * 0.08)),
          term: `rel:${rel.relation_type}`,
        });
      }
    }
  }

  const hasMasterPhrase = [...scores.entries()].some(([oid, os]) => {
    const od = documentsById.get(oid);
    return (
      od?.knowledge_unit_type === "master_field" &&
      [...os.matched].some((t) => t.startsWith("phrase:"))
    );
  });

  const hits: HybridSearchHit[] = [];
  for (const [id, s] of scores) {
    const doc = documentsById.get(id);
    if (!doc) continue;
    const typeFiltered =
      options.knowledge_unit_types &&
      !options.knowledge_unit_types.includes(doc.knowledge_unit_type);
    // Technical symbol hits bypass type filters (wrong business object type in question)
    if (typeFiltered && !s.symbol_forced) {
      continue;
    }
    if (options.metadata_filters && Object.keys(options.metadata_filters).length) {
      let ok = true;
      for (const [key, want] of Object.entries(options.metadata_filters)) {
        if (want === undefined || want === null || want === "") continue;
        const got = doc.metadata?.[key];
        if (got === undefined) {
          ok = false;
          break;
        }
        if (String(got) !== String(want)) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
    }

    const conf = doc.confidence ?? 0.5;
    const exact_score = s.exact;
    const fulltext_score = s.fulltext;
    const vector_score = s.vector;
    const metadata_score = s.meta;
    const confidence_bonus = conf * W_CONFIDENCE;
    const typeBoost =
      options.knowledgeUnitTypeBoosts?.[doc.knowledge_unit_type] ?? 0;
    let combined_score =
      exact_score * W_EXACT +
      fulltext_score * W_FULLTEXT +
      vector_score * W_VECTOR +
      metadata_score * W_METADATA +
      confidence_bonus +
      typeBoost;
    // Soft demote generic table profiles when a master_field phrase hit exists
    if (
      hasMasterPhrase &&
      doc.knowledge_unit_type === "table_profile" &&
      ![...s.matched].some((t) => t.startsWith("phrase:"))
    ) {
      combined_score -= TABLE_PROFILE_SOFT_PENALTY;
    }

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
      metadata_score,
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
