/**
 * In-memory cache for lexical corpus — avoids re-scanning canonical on every ask.
 * No index rebuild; invalidated after TTL or explicit clear.
 */
import { buildLexicalCorpus } from "@/lib/search/lexical/buildCorpus";
import type { LexicalDocument } from "@/lib/search/lexical/types";

const TTL_MS = 15 * 60 * 1000;

type CacheEntry = {
  projectKey: string;
  documents: LexicalDocument[];
  builtAt: number;
};

let cache: CacheEntry | null = null;

export function getLexicalCorpusCached(projectKey: string): LexicalDocument[] {
  const key = projectKey.trim();
  if (
    cache &&
    cache.projectKey === key &&
    Date.now() - cache.builtAt < TTL_MS
  ) {
    return cache.documents;
  }
  const documents = buildLexicalCorpus(key);
  cache = { projectKey: key, documents, builtAt: Date.now() };
  return documents;
}

export function clearLexicalCorpusCache(): void {
  cache = null;
}
