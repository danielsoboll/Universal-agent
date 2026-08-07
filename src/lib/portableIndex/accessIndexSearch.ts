/**
 * Access-Index-first retrieval for Ask (portable indexes).
 * Does not change claim/answer/intent rules — only how documents are found.
 */
import type { LocalProject } from "@/lib/localAuth/types";
import type { KnowledgeHit } from "@/lib/knowledge/types";
import { askPerfNote } from "@/lib/knowledge/askPerf";
import { namedEntityTechnicalAnchors } from "@/lib/knowledge/searchBudget/extractNamedExternalEntity";
import {
  detectLiteralQuery,
  type LiteralQueryDetection,
} from "@/lib/portableIndex/literalQuery";
import {
  fetchPortableEvidenceByIds,
  isPortableIndexReady,
  lookupPortableCodeUsage,
  lookupPortableGraphNeighbors,
  lookupPortableLiteralsExact,
  lookupPortableSymbolRecords,
  lookupPortableSymbols,
} from "@/lib/portableIndex/indexLoader";
import type { PortableLiteralRecord } from "@/lib/portableIndex/literalTypes";
import type { PortableSymbolRecord } from "@/lib/portableIndex/types";
import { getLexicalCorpusCached } from "@/lib/search/lexical/corpusCache";
import { runLexicalSearch } from "@/lib/search/lexical/runLexicalSearch";
import { expandCodeUsagesFromCanonical } from "@/lib/search/lexical/expandCodeUsages";
import { normalizeLexicalQuery } from "@/lib/search/lexical/normalizeQuery";
import type { SearchDocument } from "@/lib/search/searchDocumentSchema";
import type { LexicalSearchDiagnosis } from "@/lib/search/lexical/types";

export type AccessIndexSearchResult = {
  hits: KnowledgeHit[];
  document_count: number;
  primary_path:
    | "literal-index"
    | "symbol+graph"
    | "lexical+symbol"
    | "none";
  indexes_used: string[];
  literal_query: LiteralQueryDetection | null;
  literal_miss: boolean;
  graph_used: boolean;
  evidence_fetched: number;
  legacy_used: boolean;
  warnings: string[];
  lexical_diagnosis?: LexicalSearchDiagnosis;
  lexical_expansion_tokens?: string[];
};

function forceLegacy(): boolean {
  return process.env.ASK_FORCE_LEGACY_SEARCH === "1";
}

function symbolToThinDoc(s: PortableSymbolRecord): SearchDocument {
  const now = new Date(0).toISOString();
  return {
    search_document_id: s.document_id,
    source_system: s.system_id || s.project_id,
    source_type: s.knowledge_unit_type || s.object_type || "unknown",
    source_key: s.source_key,
    knowledge_unit_type: s.knowledge_unit_type || "unknown",
    object_type: s.object_type,
    object_name: s.object_name,
    subobject_name: s.subobject_name ?? "",
    title: s.title || s.object_name,
    technical_summary: s.title || "",
    business_purpose: "",
    facts: [],
    inferences: [],
    entities: [],
    relations: [],
    tables_read: [],
    tables_written: [],
    called_methods: [],
    called_functions: [],
    macro_calls: [],
    hardcoded_values: [],
    external_interfaces: [],
    risks: [],
    evidence: [],
    confidence: null,
    content_hash: s.content_hash || "",
    analysis_version: "",
    search_text: [s.title, s.object_name, s.subobject_name, s.source_key]
      .filter(Boolean)
      .join(" "),
    metadata: { portable_symbol_thin: true },
    created_at: now,
    updated_at: now,
  };
}

function literalToHit(
  lit: PortableLiteralRecord,
  rank: number,
): KnowledgeHit {
  const title = `${lit.object_type || "code"} / ${lit.object_name}`.trim();
  return {
    rank,
    search_document_id: `literal:${lit.literal_id}`,
    source_key: lit.source_key,
    title,
    knowledge_unit_type: "code_unit",
    combined_score: 80,
    exact_score: 4,
    fulltext_score: 0,
    vector_score: 0,
    metadata_score: 0,
    confidence_bonus: 0,
    confidence: null,
    matched_terms: [`literal:${lit.normalized_value}`],
    snippet: lit.statement_preview || lit.literal_value,
    evidence_refs: [
      lit.source_path,
      lit.line_start != null ? `L${lit.line_start}` : "",
    ].filter(Boolean),
    facts: [],
    inferences: [],
    metadata: {
      portable_literal: true,
      literal_id: lit.literal_id,
      bound_fields: lit.bound_fields,
      candidate_roles: lit.candidate_roles,
      line_start: lit.line_start,
      line_end: lit.line_end,
    },
    object_name: lit.object_name,
    object_type: lit.object_type,
    subobject_name: lit.method_or_routine || "",
    technical_summary: lit.statement_preview,
    business_purpose: "",
    tables_read: [],
    tables_written: [],
    called_methods: [],
    called_functions: [],
    hardcoded_values: [lit.literal_value],
    entities: [],
    relations: [],
    evidence: [
      {
        statement_type: "fact",
        text: lit.statement_preview || lit.literal_value,
        lines:
          lit.line_start != null
            ? [{ line: lit.line_start, quote: lit.statement_preview }]
            : [],
      },
    ],
    doc_confidence: null,
  };
}

function docToHit(
  doc: SearchDocument,
  rank: number,
  exactBoost: number,
  terms: string[],
): KnowledgeHit {
  return {
    rank,
    search_document_id: doc.search_document_id,
    source_key: doc.source_key,
    title: doc.title,
    knowledge_unit_type: doc.knowledge_unit_type,
    combined_score: 40 + exactBoost * 10,
    exact_score: exactBoost,
    fulltext_score: 0,
    vector_score: 0,
    metadata_score: 0,
    confidence_bonus: 0,
    confidence: doc.confidence,
    matched_terms: terms,
    snippet: (doc.technical_summary || doc.search_text || doc.title).slice(
      0,
      240,
    ),
    evidence_refs: [],
    facts: doc.facts ?? [],
    inferences: doc.inferences ?? [],
    metadata: (doc.metadata as Record<string, unknown>) ?? {},
    object_name: doc.object_name ?? "",
    object_type: doc.object_type ?? "",
    subobject_name: doc.subobject_name ?? "",
    technical_summary: doc.technical_summary ?? "",
    business_purpose: doc.business_purpose ?? "",
    tables_read: doc.tables_read ?? [],
    tables_written: doc.tables_written ?? [],
    called_methods: doc.called_methods ?? [],
    called_functions: doc.called_functions ?? [],
    hardcoded_values: doc.hardcoded_values ?? [],
    entities: doc.entities ?? [],
    relations: doc.relations ?? [],
    evidence: doc.evidence ?? [],
    doc_confidence: doc.confidence ?? null,
  };
}

function enrichWithEvidence(
  projectId: string,
  hits: KnowledgeHit[],
  limit: number,
): { hits: KnowledgeHit[]; fetched: number } {
  const ids = [
    ...new Set(
      hits
        .slice(0, Math.max(limit * 3, 36))
        .map((h) => h.search_document_id)
        .filter((id) => !id.startsWith("literal:")),
    ),
  ];
  if (ids.length === 0) return { hits, fetched: 0 };
  const docs = fetchPortableEvidenceByIds(projectId, ids);
  if (docs.size === 0) return { hits, fetched: 0 };
  const enriched = hits.map((h, i) => {
    const doc = docs.get(h.search_document_id);
    if (!doc) return { ...h, rank: i + 1 };
    return docToHit(doc, i + 1, Math.max(2, h.exact_score), h.matched_terms);
  });
  return { hits: enriched, fetched: docs.size };
}

/**
 * Primary Ask retrieval via portable Access Indices (when ready).
 * Returns null when caller should use legacy hybrid path.
 */
export function searchViaAccessIndexes(params: {
  project: LocalProject;
  query: string;
  limit?: number;
}): AccessIndexSearchResult | null {
  const projectId = params.project.customer_id?.trim() || "P01";
  const warnings: string[] = [];
  const indexes_used: string[] = [];
  const limit = params.limit ?? 40;

  if (forceLegacy()) {
    askPerfNote("ASK_FORCE_LEGACY_SEARCH=1 — access indexes skipped");
    return null;
  }
  if (!isPortableIndexReady(projectId)) {
    askPerfNote("portable index not ready — legacy fallback");
    return null;
  }

  const literal = detectLiteralQuery(params.query);
  if (literal.is_literal_query) {
    indexes_used.push("literal-index");
    askPerfNote(
      `access path=literal-index values=[${literal.values.slice(0, 6).join(",")}]`,
    );
    const litHits: KnowledgeHit[] = [];
    for (const value of literal.values) {
      const bound = literal.bound_fields[0];
      const rows = lookupPortableLiteralsExact({
        projectId,
        value,
        boundField: bound,
        limit: 80,
      });
      for (const row of rows) {
        litHits.push(literalToHit(row, litHits.length + 1));
      }
    }
    if (litHits.length === 0) {
      warnings.push(
        "LITERAL_INDEX: kein belegter Treffer im indexierten Codebestand.",
      );
      askPerfNote("literal miss — no vector escalation");
      return {
        hits: [],
        document_count: 0,
        primary_path: "literal-index",
        indexes_used,
        literal_query: literal,
        literal_miss: true,
        graph_used: false,
        evidence_fetched: 0,
        legacy_used: false,
        warnings,
      };
    }
    return {
      hits: litHits.slice(0, Math.max(limit, 48)).map((h, i) => ({
        ...h,
        rank: i + 1,
      })),
      document_count: litHits.length,
      primary_path: "literal-index",
      indexes_used,
      literal_query: literal,
      literal_miss: false,
      graph_used: false,
      evidence_fetched: 0,
      legacy_used: false,
      warnings,
    };
  }

  const anchors = namedEntityTechnicalAnchors(params.query);
  const candidateIds = new Set<string>();
  const matchedTerms: string[] = [];

  if (anchors.length > 0) {
    indexes_used.push("symbol-index");
    const symMap = lookupPortableSymbols(projectId, anchors);
    for (const [name, ids] of symMap) {
      matchedTerms.push(`sym:${name}`);
      for (const id of ids.slice(0, 40)) candidateIds.add(id);
    }
    askPerfNote(
      `symbol lookup anchors=[${anchors.slice(0, 6).join(",")}] → ${candidateIds.size} docs`,
    );
  }

  let lexical_diagnosis: LexicalSearchDiagnosis | undefined;
  let lexical_expansion_tokens: string[] | undefined;
  try {
    indexes_used.push("lexical-index");
    const corpus = getLexicalCorpusCached(projectId);
    const lex = runLexicalSearch({
      question: params.query,
      documents: corpus,
      limit: 60,
    });
    lexical_diagnosis = lex.diagnosis;
    lexical_expansion_tokens = lex.hits
      .slice(0, 12)
      .map((h) => h.doc.technical_name)
      .filter(Boolean);
    for (const h of lex.hits.slice(0, 40)) {
      if (h.doc.id) candidateIds.add(h.doc.id);
      // technical_name may be a symbol key
      const viaName = lookupPortableSymbols(projectId, [h.doc.technical_name]);
      for (const ids of viaName.values()) {
        for (const id of ids.slice(0, 10)) candidateIds.add(id);
      }
    }
  } catch (err) {
    warnings.push(
      `Lexikalische Suche übersprungen: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  // Code usage only for field-like anchors (ZZ_*, TABLE-FIELD) — not every exact seed
  const fieldLike = anchors.filter(
    (a) => a.includes("-") || /^ZZ_[A-Z0-9_]+$/i.test(a),
  );
  const codeHitsMerged: KnowledgeHit[] = [];
  if (fieldLike.length > 0) {
    const tokens = fieldLike;
    indexes_used.push("symbol-index/code_usage_postings");
    lookupPortableCodeUsage(projectId, tokens);
    const stems = normalizeLexicalQuery(params.query).stems;
    const seen = new Set<string>();
    const codeHits = expandCodeUsagesFromCanonical({
      projectKey: projectId,
      tokens,
      contentStems: stems,
      limit: 24,
      alreadySeen: seen,
    });
    for (const h of codeHits) {
      candidateIds.add(h.search_document_id);
      codeHitsMerged.push(h);
    }
    if (codeHits.length) {
      warnings.push(
        `Code-Expansion: ${codeHits.length} Canonical-Treffer zu [${tokens.slice(0, 4).join(", ")}]`,
      );
    }
  }

  let graph_used = false;
  const confirmedSeeds = anchors.filter((a) => {
    const m = lookupPortableSymbols(projectId, [a]);
    return (m.get(a)?.length ?? 0) > 0;
  });

  if (confirmedSeeds.length > 0) {
    indexes_used.push("graph-index");
    graph_used = true;
    const g = lookupPortableGraphNeighbors({
      projectId,
      seedNames: confirmedSeeds,
      maxNeighborsPerSeed: 20,
    });
    const neighborNames = [
      ...g.seed_nodes,
      ...g.neighbor_nodes,
    ].map((n) => n.object_name);
    const more = lookupPortableSymbols(projectId, neighborNames);
    for (const ids of more.values()) {
      for (const id of ids.slice(0, 8)) candidateIds.add(id);
    }
    // Synthetic relation hints on thin docs later via matched_terms
    if (g.edges.length) {
      matchedTerms.push(`graph:edges:${g.edges.length}`);
      warnings.push(
        `Graph-Index: ${g.seed_nodes.length} Seeds, ${g.neighbor_nodes.length} Nachbarn, ${g.edges.length} Kanten.`,
      );
    }
  }

  if (candidateIds.size === 0) {
    askPerfNote("access indexes: no candidates");
    return {
      hits: [],
      document_count: 0,
      primary_path: "none",
      indexes_used,
      literal_query: null,
      literal_miss: false,
      graph_used,
      evidence_fetched: 0,
      legacy_used: false,
      warnings: [
        ...warnings,
        "ACCESS_INDEX: keine Symbol-/Lexical-Treffer.",
      ],
      lexical_diagnosis,
      lexical_expansion_tokens,
    };
  }

  // Prefer full evidence for candidates; fall back to thin symbol records
  indexes_used.push("evidence-store");
  const idList = [...candidateIds].slice(0, 120);
  let docs = fetchPortableEvidenceByIds(projectId, idList);
  let evidence_fetched = docs.size;
  if (docs.size === 0) {
    const thin = lookupPortableSymbolRecords(projectId, idList);
    docs = new Map(thin.map((s) => [s.document_id, symbolToThinDoc(s)]));
  } else {
    // Fill gaps with thin symbols
    for (const id of idList) {
      if (docs.has(id)) continue;
      const thin = lookupPortableSymbolRecords(projectId, [id])[0];
      if (thin) docs.set(id, symbolToThinDoc(thin));
    }
  }

  let hits: KnowledgeHit[] = [...docs.values()].map((doc, i) =>
    docToHit(doc, i + 1, anchors.some((a) =>
      `${doc.title} ${doc.object_name} ${doc.source_key}`
        .toUpperCase()
        .includes(a),
    )
      ? 3
      : 1, matchedTerms),
  );

  // Merge code-usage hits that may not live in evidence-store
  const seenIds = new Set(hits.map((h) => h.search_document_id));
  for (const ch of codeHitsMerged) {
    if (seenIds.has(ch.search_document_id)) continue;
    seenIds.add(ch.search_document_id);
    hits.push(ch);
  }

  // Prefer communication / exact anchor matches
  hits.sort((a, b) => {
    const score = (h: KnowledgeHit) => {
      let s = h.exact_score * 20 + h.combined_score;
      if (h.knowledge_unit_type === "message_idoc_object") s += 50;
      if (h.knowledge_unit_type === "master_field") s += 30;
      return s;
    };
    return score(b) - score(a);
  });

  const enriched = enrichWithEvidence(projectId, hits, limit);
  hits = enriched.hits.slice(0, Math.max(limit, 48)).map((h, i) => ({
    ...h,
    rank: i + 1,
  }));
  evidence_fetched = Math.max(evidence_fetched, enriched.fetched);

  const primary_path =
    graph_used && confirmedSeeds.length > 0
      ? "symbol+graph"
      : "lexical+symbol";

  askPerfNote(
    `access path=${primary_path} hits=${hits.length} evidence=${evidence_fetched} graph=${graph_used}`,
  );

  return {
    hits,
    document_count: hits.length,
    primary_path,
    indexes_used: [...new Set(indexes_used)],
    literal_query: null,
    literal_miss: false,
    graph_used,
    evidence_fetched,
    legacy_used: false,
    warnings,
    lexical_diagnosis,
    lexical_expansion_tokens,
  };
}
