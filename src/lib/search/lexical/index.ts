export type {
  LexicalDocKind,
  LexicalDocument,
  LexicalHit,
  LexicalMatchChannel,
  LexicalSearchDiagnosis,
  LexicalSearchResult,
  NormalizedLexicalQuery,
} from "@/lib/search/lexical/types";
export {
  normalizeLexicalQuery,
  germanStemLight,
  splitCompoundParts,
} from "@/lib/search/lexical/normalizeQuery";
export { buildLexicalCorpus } from "@/lib/search/lexical/buildCorpus";
export {
  getLexicalCorpusCached,
  clearLexicalCorpusCache,
} from "@/lib/search/lexical/corpusCache";
export {
  runLexicalSearch,
  lexicalHitToPrimaryField,
} from "@/lib/search/lexical/runLexicalSearch";
export { mergeLexicalIntoHybridHits } from "@/lib/search/lexical/mergeLexicalIntoHybrid";
export { expandCodeUsagesFromCanonical } from "@/lib/search/lexical/expandCodeUsages";
export { scoreLexicalDocument, BOOST } from "@/lib/search/lexical/score";
export { buildBm25Index, bm25Score, charTrigrams } from "@/lib/search/lexical/bm25";
