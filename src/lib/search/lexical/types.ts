/**
 * Generische lexikalische DDIC-/Objektsuche — Typen.
 * Keine kundenspezifischen oder prozessspezifischen Sonderregeln.
 */

export type LexicalDocKind =
  | "ddic_table"
  | "ddic_field"
  | "data_element"
  | "domain"
  | "structure"
  | "table_profile"
  | "control_table"
  | "message_config"
  | "program"
  | "include"
  | "form_routine"
  | "function_module"
  | "class"
  | "method";

/** Durchsuchbares Dokument für die lexikalische Vorphase. */
export type LexicalDocument = {
  id: string;
  kind: LexicalDocKind;
  /** z. B. KNVV-ZZ_VLAGER oder Programmname */
  technical_name: string;
  title: string;
  search_text: string;
  table_name?: string;
  field_name?: string;
  field_text?: string;
  table_text?: string;
  data_element?: string;
  data_element_text?: string;
  domain?: string;
  domain_text?: string;
  append_include?: string | boolean | null;
  source_path: string;
  /** Kurzfassung / Code-Summary (niedrigerer Boost als DDIC-Texte). */
  code_summary?: string;
  metadata?: Record<string, unknown>;
};

export type NormalizedLexicalQuery = {
  original: string;
  phrases: string[];
  content_terms: string[];
  technical_tokens: string[];
  stopwords_removed: string[];
  /** Deutsche Grundformen / Stammvarianten der Inhaltswörter. */
  stems: string[];
  /** Komposita-Bestandteile (≥4 Zeichen). */
  compound_parts: string[];
};

export type LexicalMatchChannel =
  | "exact_technical"
  | "exact_phrase"
  | "all_terms"
  | "partial_substring"
  | "bm25"
  | "char_ngram"
  | "semantic";

export type LexicalHit = {
  doc: LexicalDocument;
  score: number;
  channels: LexicalMatchChannel[];
  boosts: Record<string, number>;
  matched_phrases: string[];
  matched_terms: string[];
  primary_anchor_candidate: boolean;
  reject_reason?: string;
};

export type LexicalSearchDiagnosis = {
  query: NormalizedLexicalQuery;
  exact_hits: number;
  phrase_hits: number;
  all_term_hits: number;
  partial_hits: number;
  bm25_hits: number;
  semantic_hits: number;
  char_ngram_hits: number;
  selected_primary_anchors: Array<{
    kind: LexicalDocKind;
    technical_name: string;
    score: number;
    reason: string;
  }>;
  rejected: Array<{
    id: string;
    technical_name: string;
    score: number;
    reason: string;
  }>;
  top_hits: Array<{
    id: string;
    kind: LexicalDocKind;
    technical_name: string;
    score: number;
    channels: LexicalMatchChannel[];
    boosts: Record<string, number>;
  }>;
};

export type LexicalSearchResult = {
  normalized: NormalizedLexicalQuery;
  hits: LexicalHit[];
  diagnosis: LexicalSearchDiagnosis;
};
