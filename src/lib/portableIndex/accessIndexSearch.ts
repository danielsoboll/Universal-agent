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
import {
  enrichConfirmedFieldSeeds,
  enrichmentPackToHits,
  type SeedEnrichmentPack,
} from "@/lib/knowledge/seedEnrichment";
import {
  hasExactAuthoritativeFlag,
  isExactAuthoritativeHit,
  markExactAuthoritativeHits,
} from "@/lib/knowledge/exactAuthoritative";
import {
  BARE_TECHNICAL_FALLBACK_BUDGETS,
  isBareTechnicalUsageHit,
  markBareTechnicalUsageHit,
  selectBareTechnicalFallbackTokens,
  tokensNeedingUsageFallback,
} from "@/lib/knowledge/bareTechnicalTokenFallback";
import {
  expandConfigTablesFromSeeds,
  isConfigTableExpansionHit,
} from "@/lib/knowledge/configTableExpansion";
import { parseFieldLikeSeeds } from "@/lib/knowledge/seedEnrichment/enrichConfirmedFieldSeeds";

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
  seed_enrichment?: SeedEnrichmentPack;
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

/**
 * When a technical token has no inventory/symbol docs, pull exact literal +
 * code-usage postings (budget-limited). No semantic expansion.
 */
function collectBareTechnicalTokenFallbackHits(params: {
  projectId: string;
  anchors: string[];
  existingHits: KnowledgeHit[];
  seenIds: Set<string>;
}): {
  hits: KnowledgeHit[];
  indexes_used: string[];
  warnings: string[];
  graph_used: boolean;
} {
  const indexes_used: string[] = [];
  const warnings: string[] = [];
  let graph_used = false;

  const candidates = selectBareTechnicalFallbackTokens(
    params.anchors,
    (token) => {
      const m = lookupPortableSymbols(params.projectId, [token]);
      return (m.get(token.toUpperCase())?.length ?? 0) > 0;
    },
  );
  const tokens = tokensNeedingUsageFallback({
    tokens: candidates,
    existingHits: params.existingHits,
  });
  if (tokens.length === 0) {
    return { hits: [], indexes_used, warnings, graph_used };
  }

  const out: KnowledgeHit[] = [];
  const seenCodeSourceKeys = new Set<string>();
  const objectNames = new Set<string>();

  for (const token of tokens) {
    indexes_used.push("literal-index/bare-token");
    const lits = lookupPortableLiteralsExact({
      projectId: params.projectId,
      value: token,
      limit: 40,
    }).filter(
      (row) => String(row.literal_value ?? "").toUpperCase() === token,
    );
    let litRank = params.existingHits.length + out.length + 1;
    for (const row of lits.slice(
      0,
      BARE_TECHNICAL_FALLBACK_BUDGETS.literals,
    )) {
      const id = `literal:${row.literal_id}`;
      if (
        params.seenIds.has(id) ||
        out.some((h) => h.search_document_id === id)
      ) {
        continue;
      }
      const hit = markBareTechnicalUsageHit(literalToHit(row, litRank++));
      hit.matched_terms = [
        ...new Set([...(hit.matched_terms ?? []), `sym:${token}`]),
      ];
      out.push(hit);
      if (row.object_name) objectNames.add(row.object_name);
    }

    indexes_used.push("symbol-index/code_usage_postings/bare-token");
    // Do not treat literal source_keys as already-seen code units — same
    // program can contribute both kschl='ZRAH' and FORM usage evidence.
    const codeHits = expandCodeUsagesFromCanonical({
      projectKey: params.projectId,
      tokens: [token],
      limit: BARE_TECHNICAL_FALLBACK_BUDGETS.code_usage,
      alreadySeen: seenCodeSourceKeys,
    });
    for (const ch of codeHits) {
      if (
        params.seenIds.has(ch.search_document_id) ||
        out.some((h) => h.search_document_id === ch.search_document_id)
      ) {
        continue;
      }
      const hit = markBareTechnicalUsageHit({
        ...ch,
        exact_score: Math.max(ch.exact_score, 3),
        matched_terms: [
          ...new Set([...(ch.matched_terms ?? []), `sym:${token}`]),
        ],
      });
      out.push(hit);
      if (ch.object_name) objectNames.add(ch.object_name);
      if (ch.source_key) seenCodeSourceKeys.add(ch.source_key);
    }
  }

  const seedObjects = [...objectNames].slice(0, 6);
  if (seedObjects.length > 0) {
    indexes_used.push("graph-index/bare-token");
    const g = lookupPortableGraphNeighbors({
      projectId: params.projectId,
      seedNames: seedObjects,
      maxNeighborsPerSeed: 6,
    });
    if (g.edges.length > 0 || g.neighbor_nodes.length > 0) {
      graph_used = true;
      const neighborNames = [...g.seed_nodes, ...g.neighbor_nodes].map(
        (n) => n.object_name,
      );
      const more = lookupPortableSymbols(params.projectId, neighborNames);
      const neighborIds = [...more.values()]
        .flat()
        .slice(0, BARE_TECHNICAL_FALLBACK_BUDGETS.graph_neighbors);
      const thin = lookupPortableSymbolRecords(params.projectId, neighborIds);
      let rank = params.existingHits.length + out.length + 1;
      for (const s of thin) {
        if (
          params.seenIds.has(s.document_id) ||
          out.some((h) => h.search_document_id === s.document_id)
        ) {
          continue;
        }
        const hit = markBareTechnicalUsageHit(
          docToHit(symbolToThinDoc(s), rank++, 2, [
            "bare_technical_usage",
            "graph:bare-token",
          ]),
        );
        out.push(hit);
      }
      warnings.push(
        `Bare-Token-Fallback Graph: ${g.seed_nodes.length} Seeds, ${g.neighbor_nodes.length} Nachbarn.`,
      );
    }
  }

  if (out.length > 0) {
    warnings.push(
      `Bare-Token-Fallback: ${tokens.join(", ")} → ${out.length} Literal/Code-Usage-Treffer (kein Inventory-Symbol).`,
    );
    askPerfNote(
      `bare technical token fallback tokens=[${tokens.join(",")}] hits=${out.length}`,
    );
  }

  return {
    hits: out,
    indexes_used: [...new Set(indexes_used)],
    warnings,
    graph_used,
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

  // Generic FIELD seed enrichment (master instances, values, code, config).
  // Seeds: confirmed question anchors + field-like lexical/symbol hits
  // (questions often say "virtuelles Lager" without naming ZZ_* explicitly).
  let seed_enrichment: SeedEnrichmentPack | undefined;
  const lexicalFieldSeeds = (lexical_expansion_tokens ?? []).filter(
    (t) => typeof t === "string" && (t.includes("-") || /^ZZ_[A-Z0-9_]+$/i.test(t)),
  );
  const enrichmentSeedNames = [
    ...new Set([...confirmedSeeds, ...fieldLike, ...lexicalFieldSeeds]),
  ];
  if (enrichmentSeedNames.length > 0) {
    seed_enrichment = enrichConfirmedFieldSeeds({
      projectId,
      systemId: params.project.system_id || "D01",
      confirmedSeeds: enrichmentSeedNames,
    });
    if (seed_enrichment.enriched) {
      indexes_used.push("seed-enrichment/entities");
      warnings.push(
        `Seed-Enrichment: ${seed_enrichment.notes.join("; ")}`,
      );
    }
  }

  let hits: KnowledgeHit[] = [];
  let evidence_fetched = 0;

  if (candidateIds.size === 0) {
    askPerfNote("access indexes: no symbol/lexical candidates");
    warnings.push("ACCESS_INDEX: keine Symbol-/Lexical-Treffer.");
  } else {
    // Prefer full evidence for candidates; fall back to thin symbol records
    indexes_used.push("evidence-store");
    const idList = [...candidateIds].slice(0, 120);
    let docs = fetchPortableEvidenceByIds(projectId, idList);
    evidence_fetched = docs.size;
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

    hits = [...docs.values()].map((doc, i) =>
      docToHit(
        doc,
        i + 1,
        anchors.some((a) =>
          `${doc.title} ${doc.object_name} ${doc.source_key}`
            .toUpperCase()
            .includes(a),
        )
          ? 3
          : 1,
        matchedTerms,
      ),
    );
  }

  // Merge code-usage hits that may not live in evidence-store
  const seenIds = new Set(hits.map((h) => h.search_document_id));
  for (const ch of codeHitsMerged) {
    if (seenIds.has(ch.search_document_id)) continue;
    seenIds.add(ch.search_document_id);
    hits.push(ch);
  }

  // Bare technical tokens (ZRAH, …) without inventory symbols: exact literal +
  // code-usage only — no semantic broadening.
  const bareFallback = collectBareTechnicalTokenFallbackHits({
    projectId,
    anchors,
    existingHits: hits,
    seenIds,
  });
  if (bareFallback.hits.length > 0) {
    indexes_used.push(...bareFallback.indexes_used);
    warnings.push(...bareFallback.warnings);
    for (const h of bareFallback.hits) {
      if (seenIds.has(h.search_document_id)) continue;
      seenIds.add(h.search_document_id);
      hits.push(h);
    }
    if (bareFallback.graph_used) graph_used = true;
  }

  if (hits.length === 0) {
    askPerfNote("access indexes: no candidates after bare-token fallback");
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
      warnings,
      lexical_diagnosis,
      lexical_expansion_tokens,
      seed_enrichment,
    };
  }

  // Prefer evidence proximity to confirmed seeds over source-family bias.
  // exact authoritative definition/config > seed enrichment > graph/symbol > lexical;
  // message_idoc / other families are only a small secondary factor.
  hits = markExactAuthoritativeHits(hits, [
    ...confirmedSeeds,
    ...namedEntityTechnicalAnchors(params.query),
  ]);

  const scoreAccessHit = (h: KnowledgeHit): number => {
    let s = h.exact_score * 20 + h.combined_score;
    const terms = h.matched_terms ?? [];
    const isSeedEnrichment =
      h.metadata?.seed_enrichment === true ||
      terms.some((t) => String(t).toLowerCase() === "seed_enrichment") ||
      String(h.search_document_id ?? "").startsWith("enrichment:");

    // authoritative exact > seed > direct literal/code usage > soft lexical
    if (
      hasExactAuthoritativeFlag(h) ||
      isExactAuthoritativeHit(h, [
        ...confirmedSeeds,
        ...namedEntityTechnicalAnchors(params.query),
      ])
    ) {
      s += 220;
    } else if (isSeedEnrichment) {
      s += 100;
    } else if (isConfigTableExpansionHit(h)) {
      // Direct config/table evidence from confirmed seed — above soft lexical,
      // below authoritative inventory definition of the seed itself.
      s += 95;
    } else if (isBareTechnicalUsageHit(h)) {
      s += 90;
    }

    const blob =
      `${h.title} ${h.object_name} ${h.subobject_name} ${h.source_key}`.toUpperCase();
    for (const seed of enrichmentSeedNames) {
      const needle = seed.trim().toUpperCase();
      if (needle.length >= 3 && blob.includes(needle)) {
        s += 45;
        break;
      }
    }

    if (terms.some((t) => String(t).startsWith("sym:"))) s += 15;
    // Graph edge count is secondary — must not outrank exact authoritative.
    if (terms.some((t) => String(t).startsWith("graph:"))) s += 8;

    // Secondary source-family weights (kept small on purpose).
    const kut = String(h.knowledge_unit_type ?? "");
    if (kut === "master_field") s += 8;
    else if (kut === "code_unit") s += 5;
    else if (kut === "message_idoc_object") s += 4;
    return s;
  };

  hits.sort((a, b) => scoreAccessHit(b) - scoreAccessHit(a));

  const enriched = enrichWithEvidence(projectId, hits, limit);
  hits = enriched.hits.slice(0, Math.max(limit, 48)).map((h, i) => ({
    ...h,
    rank: i + 1,
  }));
  evidence_fetched = Math.max(evidence_fetched, enriched.fetched);

  // Second-pass enrichment seeds from retrieved master_field / symbol hits
  const hitFieldSeeds: string[] = [];
  for (const h of hits.slice(0, 30)) {
    const blob = `${h.title} ${h.object_name} ${h.source_key} ${(h.matched_terms ?? []).join(" ")}`;
    for (const m of blob.matchAll(/\b([A-Z][A-Z0-9_]{2,30})-(ZZ_[A-Z0-9_]+|[A-Z][A-Z0-9_]{2,30})\b/g)) {
      hitFieldSeeds.push(`${m[1]}-${m[2]}`.toUpperCase());
    }
    for (const m of blob.matchAll(/\b(ZZ_[A-Z0-9_]{2,40})\b/g)) {
      hitFieldSeeds.push(m[1]!.toUpperCase());
    }
  }
  if (hitFieldSeeds.length > 0) {
    const pass2 = enrichConfirmedFieldSeeds({
      projectId,
      systemId: params.project.system_id || "D01",
      confirmedSeeds: [...new Set(hitFieldSeeds)],
    });
    if (pass2.enriched) {
      // Merge with pass-1 pack so later hit-derived seeds cannot wipe earlier
      // confirmed enrichment (generic: keep richest evidence per seed).
      if (seed_enrichment?.enriched) {
        const bySeed = new Map(
          seed_enrichment.field_enrichments.map((e) => [
            e.seed.seed.toUpperCase(),
            e,
          ]),
        );
        for (const e of pass2.field_enrichments) {
          const key = e.seed.seed.toUpperCase();
          const prev = bySeed.get(key);
          if (
            !prev ||
            e.master_instances.total_attributes >
              prev.master_instances.total_attributes ||
            e.code_usage.total > prev.code_usage.total
          ) {
            bySeed.set(key, e);
          }
        }
        seed_enrichment = {
          enriched: true,
          field_enrichments: [...bySeed.values()],
          notes: [...new Set([...seed_enrichment.notes, ...pass2.notes])],
        };
      } else {
        seed_enrichment = pass2;
      }
      if (!indexes_used.includes("seed-enrichment/entities")) {
        indexes_used.push("seed-enrichment/entities");
      }
      warnings.push(`Seed-Enrichment (from hits): ${pass2.notes.join("; ")}`);
    }
  }

  if (seed_enrichment?.enriched) {
    const enrichHits = enrichmentPackToHits(seed_enrichment, 1);
    const enrichIds = new Set(enrichHits.map((h) => h.search_document_id));
    const rest = hits.filter((h) => !enrichIds.has(h.search_document_id));
    // Keep enrichment first, then re-score remainder with the same seed-proximity rule.
    rest.sort((a, b) => scoreAccessHit(b) - scoreAccessHit(a));
    hits = [...enrichHits, ...rest]
      .slice(0, Math.max(limit, 56))
      .map((h, i) => ({
        ...h,
        rank: i + 1,
      }));
    for (const h of hits) seenIds.add(h.search_document_id);
  }

  // Deterministic 1-hop config/table expansion from confirmed technical seeds
  // (after enrichment so ZZ_* / TABLE-FIELD seeds are available).
  const enrichmentFieldSeeds = (seed_enrichment?.field_enrichments ?? [])
    .filter(
      (e) =>
        e.master_instances.total_attributes > 0 ||
        e.code_usage.total > 0 ||
        e.config_neighbors.length > 0 ||
        e.observed_values.length > 0,
    )
    .flatMap((e) => [
      e.seed.seed,
      e.seed.field_name,
      e.seed.table_name ? `${e.seed.table_name}-${e.seed.field_name}` : "",
    ]);
  const expansionSeeds = [
    ...new Set(
      parseFieldLikeSeeds([
        ...confirmedSeeds,
        ...fieldLike,
        ...hitFieldSeeds,
        ...enrichmentFieldSeeds,
      ]).flatMap((s) => [s.seed, s.field_name]),
    ),
  ].filter(Boolean);
  if (expansionSeeds.length > 0) {
    const cfg = expandConfigTablesFromSeeds({
      projectId,
      confirmedSeeds: expansionSeeds,
      alreadySeenIds: seenIds,
    });
    if (cfg.hits.length > 0) {
      indexes_used.push(...cfg.indexes_used);
      warnings.push(...cfg.warnings);
      for (const h of cfg.hits) {
        const existingIdx = hits.findIndex(
          (x) => x.search_document_id === h.search_document_id,
        );
        if (existingIdx >= 0) {
          // Remarqu graph/lexical hit with seed→table proximity (1-hop).
          const prev = hits[existingIdx]!;
          const terms = new Set([
            ...(prev.matched_terms ?? []),
            ...(h.matched_terms ?? []),
          ]);
          hits[existingIdx] = {
            ...prev,
            matched_terms: [...terms],
            metadata: {
              ...(prev.metadata ?? {}),
              ...(h.metadata ?? {}),
              config_table_expansion: true,
            },
            exact_score: Math.max(prev.exact_score, h.exact_score, 3),
          };
          continue;
        }
        seenIds.add(h.search_document_id);
        hits.push(h);
      }
      if (cfg.trace.length) {
        matchedTerms.push(`config_exp:${cfg.trace.length}`);
        warnings.push(
          `Config-Expansion Trace: ${cfg.trace
            .slice(0, 6)
            .map(
              (t) =>
                `${t.seed} --${t.relation_type}→ ${t.table_name} (${t.candidate_ids.length})`,
            )
            .join("; ")}`,
        );
      }
    }
  }

  hits = markExactAuthoritativeHits(hits, [
    ...confirmedSeeds,
    ...namedEntityTechnicalAnchors(params.query),
  ]).map((h, i) => ({ ...h, rank: i + 1 }));
  // Keep exact authoritative docs ahead of non-authoritative after final mark.
  hits.sort((a, b) => scoreAccessHit(b) - scoreAccessHit(a));
  hits = hits.map((h, i) => ({ ...h, rank: i + 1 }));

  const primary_path =
    graph_used && confirmedSeeds.length > 0
      ? "symbol+graph"
      : "lexical+symbol";

  askPerfNote(
    `access path=${primary_path} hits=${hits.length} evidence=${evidence_fetched} graph=${graph_used} enrichment=${seed_enrichment?.enriched ? "yes" : "no"}`,
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
    seed_enrichment,
  };
}
