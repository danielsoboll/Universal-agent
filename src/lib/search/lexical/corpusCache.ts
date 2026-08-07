/**
 * In-memory cache for lexical corpus.
 * Prefers portable lexical-index on disk; falls back to canonical rebuild.
 */
import { buildLexicalCorpus } from "@/lib/search/lexical/buildCorpus";
import type { LexicalDocument } from "@/lib/search/lexical/types";
import {
  askPerfBegin,
  askPerfEnd,
  askPerfNote,
  askPerfSetLexicalCacheHit,
} from "@/lib/knowledge/askPerf";
import { lexicalSourceFingerprint } from "@/lib/knowledge/projectKnowledgeCache";
import {
  isPortableIndexReady,
  loadPortableLexicalDocuments,
} from "@/lib/portableIndex/indexLoader";

type CacheEntry = {
  projectKey: string;
  fingerprint: string;
  documents: LexicalDocument[];
  builtAt: number;
  source: "portable" | "canonical";
};

let cache: CacheEntry | null = null;

export function getLexicalCorpusCached(projectKey: string): LexicalDocument[] {
  const key = projectKey.trim();
  askPerfBegin("lexical_corpus_load");

  if (isPortableIndexReady(key)) {
    const portable = loadPortableLexicalDocuments(key);
    if (portable && portable.length > 0) {
      const fp = `portable:${portable.length}`;
      if (
        cache &&
        cache.projectKey === key &&
        cache.fingerprint === fp &&
        cache.source === "portable"
      ) {
        askPerfSetLexicalCacheHit(true);
        askPerfNote(
          `Lexical corpus cache HIT portable (${cache.documents.length} docs, age_ms=${Date.now() - cache.builtAt})`,
        );
        askPerfEnd("lexical_corpus_load");
        return cache.documents;
      }
      askPerfSetLexicalCacheHit(Boolean(cache?.source === "portable"));
      askPerfNote(
        `Lexical corpus from portable-index (${portable.length} docs)`,
      );
      cache = {
        projectKey: key,
        fingerprint: fp,
        documents: portable,
        builtAt: Date.now(),
        source: "portable",
      };
      askPerfEnd("lexical_corpus_load");
      return portable;
    }
    askPerfNote(
      "portable lexical missing/empty — fallback to canonical rebuild",
    );
  }

  const fp = lexicalSourceFingerprint(key);
  if (
    cache &&
    cache.projectKey === key &&
    cache.fingerprint === fp &&
    cache.source === "canonical"
  ) {
    askPerfSetLexicalCacheHit(true);
    askPerfNote(
      `Lexical corpus cache HIT canonical (${cache.documents.length} docs, age_ms=${Date.now() - cache.builtAt})`,
    );
    askPerfEnd("lexical_corpus_load");
    return cache.documents;
  }
  askPerfSetLexicalCacheHit(false);
  askPerfNote(
    cache && cache.projectKey === key
      ? "Lexical corpus cache MISS — source fingerprint changed"
      : "Lexical corpus cache MISS — rebuilding from canonical/analyses",
  );
  const documents = buildLexicalCorpus(key);
  cache = {
    projectKey: key,
    fingerprint: fp,
    documents,
    builtAt: Date.now(),
    source: "canonical",
  };
  askPerfNote(`Lexical corpus rebuilt: ${documents.length} docs`);
  askPerfEnd("lexical_corpus_load");
  return documents;
}

export function clearLexicalCorpusCache(): void {
  cache = null;
}
