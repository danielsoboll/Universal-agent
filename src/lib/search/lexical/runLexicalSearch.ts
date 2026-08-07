/**
 * Lexikalische Suche vor Semantik:
 * 1 Exact Technical → 2 Exact Phrase → 3 All-Term → 4 Partial/Substring
 * → 5 BM25 → 6 optional Semantic (nur Scores, kein OpenAI hier).
 */
import { bm25Score, buildBm25Index, charNgramOverlap } from "@/lib/search/lexical/bm25";
import { normalizeLexicalQuery } from "@/lib/search/lexical/normalizeQuery";
import { scoreLexicalDocument } from "@/lib/search/lexical/score";
import type {
  LexicalDocument,
  LexicalHit,
  LexicalSearchDiagnosis,
  LexicalSearchResult,
  NormalizedLexicalQuery,
} from "@/lib/search/lexical/types";

function fold(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss");
}

function hasPhrase(doc: LexicalDocument, phrase: string): boolean {
  const p = fold(phrase);
  if (p.length < 4) return false;
  const blobs = [
    doc.field_text,
    doc.table_text,
    doc.data_element_text,
    doc.domain_text,
    doc.title,
    doc.search_text,
  ];
  return blobs.some((b) => b && fold(b).includes(p));
}

function hasAllTerms(doc: LexicalDocument, terms: string[]): boolean {
  if (terms.length === 0) return false;
  const blob = fold(doc.search_text + " " + (doc.field_text ?? ""));
  return terms.every((t) => blob.includes(fold(t)));
}

function hasAnyTerm(doc: LexicalDocument, terms: string[]): boolean {
  const blob = fold(doc.search_text + " " + (doc.field_text ?? "") + " " + doc.technical_name);
  return terms.some((t) => t.length >= 3 && blob.includes(fold(t)));
}

export type RunLexicalSearchParams = {
  question: string;
  documents: LexicalDocument[];
  /** Optional vorab berechnete Cosine-Ähnlichkeiten docId → 0..1 */
  semanticScores?: Map<string, number>;
  limit?: number;
};

export function runLexicalSearch(
  params: RunLexicalSearchParams,
): LexicalSearchResult {
  const normalized = normalizeLexicalQuery(params.question);
  const limit = params.limit ?? 40;
  const docs = params.documents;

  const exactTechIds = new Set<string>();
  const phraseIds = new Set<string>();
  const allTermIds = new Set<string>();
  const partialIds = new Set<string>();
  const ngramIds = new Set<string>();

  for (const doc of docs) {
    const tech = doc.technical_name.toUpperCase();
    for (const tok of normalized.technical_tokens) {
      if (tok.length >= 3 && (tech === tok || tech.includes(tok))) {
        exactTechIds.add(doc.id);
      }
    }
    for (const phrase of normalized.phrases) {
      if (hasPhrase(doc, phrase)) {
        phraseIds.add(doc.id);
        break;
      }
    }
    if (normalized.content_terms.length >= 2 && hasAllTerms(doc, normalized.content_terms)) {
      allTermIds.add(doc.id);
    } else if (hasAnyTerm(doc, normalized.content_terms)) {
      partialIds.add(doc.id);
    }
    for (const tok of [
      ...normalized.technical_tokens,
      ...normalized.content_terms,
    ]) {
      if (tok.length >= 4 && charNgramOverlap(doc.technical_name, tok) >= 0.5) {
        ngramIds.add(doc.id);
      }
    }
  }

  const bm25Index = buildBm25Index(
    docs.map((d) => ({ id: d.id, text: d.search_text })),
  );
  const bm25Query = [
    ...normalized.content_terms,
    ...normalized.phrases.flatMap((p) => p.split(/\s+/)),
    ...normalized.technical_tokens.map((t) => t.toLowerCase()),
  ];
  const bm25Scores = new Map<string, number>();
  for (const doc of docs) {
    const s = bm25Score(bm25Index, doc.id, bm25Query);
    if (s > 0) bm25Scores.set(doc.id, s);
  }

  const candidateIds = new Set<string>([
    ...exactTechIds,
    ...phraseIds,
    ...allTermIds,
    ...partialIds,
    ...ngramIds,
    ...bm25Scores.keys(),
  ]);
  if (params.semanticScores) {
    for (const id of params.semanticScores.keys()) candidateIds.add(id);
  }

  // Wenn nichts matchte: trotzdem Top-BM25 aus gesamtem Korpus (leere Candidate-Menge)
  if (candidateIds.size === 0) {
    const topBm = [...bm25Scores.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit);
    for (const [id] of topBm) candidateIds.add(id);
  }

  const byId = new Map(docs.map((d) => [d.id, d]));
  const hits: LexicalHit[] = [];
  for (const id of candidateIds) {
    const doc = byId.get(id);
    if (!doc) continue;
    const channels: import("@/lib/search/lexical/types").LexicalMatchChannel[] =
      [];
    if (exactTechIds.has(id)) channels.push("exact_technical");
    if (phraseIds.has(id)) channels.push("exact_phrase");
    if (allTermIds.has(id)) channels.push("all_terms");
    if (partialIds.has(id)) channels.push("partial_substring");
    if (ngramIds.has(id)) channels.push("char_ngram");
    if (bm25Scores.has(id)) channels.push("bm25");
    const semantic = params.semanticScores?.get(id);
    if (semantic && semantic > 0) channels.push("semantic");

    const hit = scoreLexicalDocument(doc, normalized, {
      bm25: bm25Scores.get(id) ?? 0,
      semantic,
      channels,
    });
    if (hit.score > 0) hits.push(hit);
  }

  hits.sort((a, b) => {
    const ap = a.channels.includes("exact_phrase") ? 1 : 0;
    const bp = b.channels.includes("exact_phrase") ? 1 : 0;
    if (bp !== ap) return bp - ap;
    const af = a.doc.kind === "ddic_field" ? 1 : 0;
    const bf = b.doc.kind === "ddic_field" ? 1 : 0;
    if (bf !== af) return bf - af;
    return b.score - a.score || a.doc.id.localeCompare(b.doc.id);
  });
  const top = hits.slice(0, limit);

  const selected = top
    .filter((h) => h.primary_anchor_candidate)
    .slice(0, 5)
    .map((h) => ({
      kind: h.doc.kind,
      technical_name: h.doc.technical_name,
      score: h.score,
      reason: h.channels.includes("exact_phrase")
        ? "exakte Phrase in DDIC-/Beschreibungstext"
        : h.channels.includes("exact_technical")
          ? "exakter technischer Name"
          : "alle Inhaltswörter im Dokument",
    }));

  const rejected = hits
    .filter((h) => !h.primary_anchor_candidate && h.score > 0)
    .slice(0, 25)
    .map((h) => ({
      id: h.doc.id,
      technical_name: h.doc.technical_name,
      score: h.score,
      reason:
        h.score < 90
          ? "Score unter Primäranker-Schwelle"
          : "kein starker Phrase-/Technik-/All-Terms-Treffer",
    }));

  const diagnosis: LexicalSearchDiagnosis = {
    query: normalized,
    exact_hits: exactTechIds.size,
    phrase_hits: phraseIds.size,
    all_term_hits: allTermIds.size,
    partial_hits: partialIds.size,
    bm25_hits: bm25Scores.size,
    semantic_hits: params.semanticScores?.size ?? 0,
    char_ngram_hits: ngramIds.size,
    selected_primary_anchors: selected,
    rejected,
    top_hits: top.slice(0, 15).map((h) => ({
      id: h.doc.id,
      kind: h.doc.kind,
      technical_name: h.doc.technical_name,
      score: h.score,
      channels: h.channels,
      boosts: h.boosts,
    })),
  };

  return { normalized, hits: top, diagnosis };
}

export function lexicalHitToPrimaryField(hit: LexicalHit): {
  table: string;
  field: string;
  description: string;
  score: number;
} | null {
  if (hit.doc.kind !== "ddic_field") return null;
  if (!hit.doc.table_name || !hit.doc.field_name) return null;
  if (!hit.primary_anchor_candidate) return null;
  return {
    table: hit.doc.table_name,
    field: hit.doc.field_name,
    description: hit.doc.field_text ?? hit.doc.title,
    score: hit.score,
  };
}

export type { NormalizedLexicalQuery };
