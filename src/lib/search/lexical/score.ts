/**
 * Ranking-Boosts für lexikalische Treffer (vor Semantik).
 */
import type { LexicalDocument, LexicalHit, LexicalMatchChannel } from "@/lib/search/lexical/types";
import type { NormalizedLexicalQuery } from "@/lib/search/lexical/types";

export const BOOST = {
  EXACT_PHRASE_FIELD_TEXT: 120,
  EXACT_PHRASE_TABLE_TEXT: 110,
  EXACT_PHRASE_DATA_ELEMENT_TEXT: 105,
  EXACT_PHRASE_SEARCH_TEXT: 90,
  EXACT_TECHNICAL_NAME: 100,
  ALL_CONTENT_TERMS: 70,
  DDIC_DESCRIPTION: 45,
  CODE_SUMMARY: 28,
  SINGLE_TERM: 12,
  CHAR_NGRAM_TECHNICAL: 35,
  BM25: 1, // scaled separately
  SEMANTIC: 8,
  DDIC_FIELD_KIND: 15,
  CONTROL_TABLE_KIND: 10,
  Z_FIELD_NAME: 20,
} as const;

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

export function descriptionBlob(doc: LexicalDocument): string {
  return fold(
    [
      doc.field_text,
      doc.table_text,
      doc.data_element_text,
      doc.domain_text,
      doc.title,
    ]
      .filter(Boolean)
      .join(" "),
  );
}

export function phraseIn(haystack: string | undefined | null, phrase: string): boolean {
  if (!haystack || !phrase) return false;
  return fold(haystack).includes(fold(phrase));
}

export function scoreLexicalDocument(
  doc: LexicalDocument,
  query: NormalizedLexicalQuery,
  extras?: {
    bm25?: number;
    semantic?: number;
    channels?: LexicalMatchChannel[];
  },
): LexicalHit {
  const boosts: Record<string, number> = {};
  const channels = new Set<LexicalMatchChannel>(extras?.channels ?? []);
  const matched_phrases: string[] = [];
  const matched_terms: string[] = [];

  const techUpper = doc.technical_name.toUpperCase();
  for (const tok of query.technical_tokens) {
    if (tok.length >= 3 && (techUpper === tok || techUpper.includes(tok))) {
      boosts.exact_technical = (boosts.exact_technical ?? 0) + BOOST.EXACT_TECHNICAL_NAME;
      channels.add("exact_technical");
      matched_terms.push(tok);
      break;
    }
  }

  for (const phrase of query.phrases) {
    if (phrase.length < 5) continue;
    if (phraseIn(doc.field_text, phrase)) {
      boosts.exact_phrase_field_text =
        (boosts.exact_phrase_field_text ?? 0) + BOOST.EXACT_PHRASE_FIELD_TEXT;
      channels.add("exact_phrase");
      matched_phrases.push(phrase);
      break;
    }
    if (phraseIn(doc.table_text, phrase)) {
      boosts.exact_phrase_table_text =
        (boosts.exact_phrase_table_text ?? 0) + BOOST.EXACT_PHRASE_TABLE_TEXT;
      channels.add("exact_phrase");
      matched_phrases.push(phrase);
      break;
    }
    if (phraseIn(doc.data_element_text, phrase)) {
      boosts.exact_phrase_de_text =
        (boosts.exact_phrase_de_text ?? 0) + BOOST.EXACT_PHRASE_DATA_ELEMENT_TEXT;
      channels.add("exact_phrase");
      matched_phrases.push(phrase);
      break;
    }
    if (phraseIn(doc.search_text, phrase) || phraseIn(doc.title, phrase)) {
      boosts.exact_phrase_search =
        (boosts.exact_phrase_search ?? 0) + BOOST.EXACT_PHRASE_SEARCH_TEXT;
      channels.add("exact_phrase");
      matched_phrases.push(phrase);
      break;
    }
  }

  const desc = descriptionBlob(doc);
  const searchFold = fold(doc.search_text);
  const terms = query.content_terms.filter((t) => t.length >= 3);
  if (terms.length > 0) {
    const hitTerms = terms.filter(
      (t) => desc.includes(fold(t)) || searchFold.includes(fold(t)),
    );
    matched_terms.push(...hitTerms);
    if (hitTerms.length === terms.length && terms.length >= 2) {
      boosts.all_content_terms = BOOST.ALL_CONTENT_TERMS;
      channels.add("all_terms");
    } else if (hitTerms.length > 0) {
      boosts.single_terms = hitTerms.length * BOOST.SINGLE_TERM;
      if (!channels.has("exact_phrase")) channels.add("partial_substring");
    }

    // DDIC-Beschreibungen vs. Code
    const ddicHit = hitTerms.some(
      (t) =>
        phraseIn(doc.field_text, t) ||
        phraseIn(doc.table_text, t) ||
        phraseIn(doc.data_element_text, t) ||
        phraseIn(doc.domain_text, t),
    );
    if (ddicHit) {
      boosts.ddic_description = BOOST.DDIC_DESCRIPTION;
    } else if (
      doc.code_summary &&
      hitTerms.some((t) => fold(doc.code_summary!).includes(fold(t)))
    ) {
      boosts.code_summary = BOOST.CODE_SUMMARY;
    }
  }

  // Char-N-Gram / Substring auf technische Namen
  const techFold = fold(doc.technical_name);
  for (const tok of [...query.technical_tokens, ...query.content_terms]) {
    const needle = fold(tok.replace(/-/g, ""));
    if (needle.length >= 4 && techFold.replace(/-/g, "").includes(needle)) {
      boosts.char_ngram = Math.max(boosts.char_ngram ?? 0, BOOST.CHAR_NGRAM_TECHNICAL);
      channels.add("char_ngram");
      channels.add("partial_substring");
    }
  }

  if (extras?.bm25 && extras.bm25 > 0) {
    // BM25 nur als schwache Ergänzung — Phrasen/Technik bleiben dominant
    boosts.bm25 = Math.min(40, extras.bm25 * 6);
    channels.add("bm25");
  }
  if (extras?.semantic && extras.semantic > 0) {
    boosts.semantic = extras.semantic * BOOST.SEMANTIC;
    channels.add("semantic");
  }

  if (doc.kind === "ddic_field") {
    boosts.kind_ddic_field = BOOST.DDIC_FIELD_KIND;
  } else if (doc.kind === "control_table") {
    boosts.kind_control = BOOST.CONTROL_TABLE_KIND;
  }

  const fname = (doc.field_name ?? "").toUpperCase();
  if (/^(Z|Y|ZZ|YY)/.test(fname) || fname.includes("_Z")) {
    boosts.z_field = BOOST.Z_FIELD_NAME;
  }

  const score = Object.values(boosts).reduce((a, b) => a + b, 0);
  const isDdicLike =
    doc.kind === "ddic_field" ||
    doc.kind === "control_table" ||
    doc.kind === "ddic_table";
  const primary_anchor_candidate =
    score >= 90 &&
    isDdicLike &&
    (channels.has("exact_phrase") ||
      channels.has("exact_technical") ||
      (channels.has("all_terms") && doc.kind === "ddic_field"));

  return {
    doc,
    score,
    channels: [...channels],
    boosts,
    matched_phrases: [...new Set(matched_phrases)],
    matched_terms: [...new Set(matched_terms)],
    primary_anchor_candidate,
  };
}
