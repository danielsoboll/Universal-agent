/**
 * Einfaches BM25 über Token-Bags (kein externes Dependency).
 */
import { foldSearchDiacritics } from "@/lib/search/buildLocalSearchIndex";

export function tokenizeBm25(text: string): string[] {
  return foldSearchDiacritics(text)
    .toLowerCase()
    .split(/[^a-z0-9_]+/g)
    .filter((t) => t.length >= 2);
}

export type Bm25Index = {
  docTokens: Map<string, string[]>;
  df: Map<string, number>;
  avgdl: number;
  N: number;
};

export function buildBm25Index(
  docs: Array<{ id: string; text: string }>,
): Bm25Index {
  const docTokens = new Map<string, string[]>();
  const df = new Map<string, number>();
  let totalLen = 0;
  for (const d of docs) {
    const toks = tokenizeBm25(d.text);
    docTokens.set(d.id, toks);
    totalLen += toks.length;
    const seen = new Set(toks);
    for (const t of seen) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const N = docs.length || 1;
  return { docTokens, df, avgdl: totalLen / N, N };
}

export function bm25Score(
  index: Bm25Index,
  docId: string,
  queryTerms: string[],
  k1 = 1.2,
  b = 0.75,
): number {
  const toks = index.docTokens.get(docId);
  if (!toks || toks.length === 0) return 0;
  const tfMap = new Map<string, number>();
  for (const t of toks) tfMap.set(t, (tfMap.get(t) ?? 0) + 1);
  const dl = toks.length;
  let score = 0;
  for (const raw of queryTerms) {
    const q = foldSearchDiacritics(raw).toLowerCase();
    if (q.length < 2) continue;
    const tf = tfMap.get(q) ?? 0;
    if (tf === 0) continue;
    const df = index.df.get(q) ?? 0;
    const idf = Math.log(1 + (index.N - df + 0.5) / (df + 0.5));
    const denom = tf + k1 * (1 - b + b * (dl / (index.avgdl || 1)));
    score += idf * ((tf * (k1 + 1)) / denom);
  }
  return score;
}

/** Char-Trigramme für technische Namen. */
export function charTrigrams(s: string): string[] {
  const t = s.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (t.length < 3) return t.length ? [t] : [];
  const out: string[] = [];
  for (let i = 0; i + 3 <= t.length; i += 1) out.push(t.slice(i, i + 3));
  return out;
}

export function charNgramOverlap(a: string, b: string): number {
  const A = new Set(charTrigrams(a));
  const B = new Set(charTrigrams(b));
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter += 1;
  return inter / Math.min(A.size, B.size);
}
