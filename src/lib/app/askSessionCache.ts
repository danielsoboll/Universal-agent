/**
 * Ask page session cache — display-only.
 *
 * MUST NOT be read by Retrieval, Query Planner, Entity Grounding, or Answer
 * Synthesizer. It only stores finished results so the UI can switch search
 * modes for the exact same question without re-calling the API.
 */

import type { AskQuestionResult } from "@/actions/ask";
import type { SearchMode } from "@/lib/knowledge/queryPlanSchema";

export const ASK_SESSION_CACHE_KEY = "ga-ask-session-cache-v2";
export const ASK_SESSION_MAX_ENTRIES = 12; // up to ~3 questions × 2 modes + slack

export type AskCacheKeyParts = {
  projectId: string;
  sessionId: string;
  normalizedQuestion: string;
  searchMode: SearchMode;
  indexVersion: string;
  searchProfileVersion: string;
  plannerPromptVersion: string;
  answerPromptVersion: string;
};

export type AskCacheEntry = {
  key: AskCacheKeyParts;
  keyString: string;
  result: AskQuestionResult;
  createdAt: string;
};

type AskSessionCacheFile = { entries: AskCacheEntry[] };

export function normalizeAskQuestion(q: string): string {
  return q.trim().replace(/\s+/g, " ");
}

export function buildAskCacheKeyString(parts: AskCacheKeyParts): string {
  return [
    parts.projectId,
    parts.sessionId,
    parts.normalizedQuestion,
    parts.searchMode,
    parts.indexVersion,
    parts.searchProfileVersion,
    parts.plannerPromptVersion,
    parts.answerPromptVersion,
  ].join("\u001f");
}

/** Loose identity for "same question + mode + project" (mode switch before versions known). */
export function askCacheIdentity(
  projectId: string,
  normalizedQuestion: string,
  searchMode: SearchMode,
): string {
  return [projectId, normalizedQuestion, searchMode].join("\u001f");
}

function readCache(): AskSessionCacheFile {
  if (typeof window === "undefined") return { entries: [] };
  try {
    const raw = sessionStorage.getItem(ASK_SESSION_CACHE_KEY);
    if (!raw) return { entries: [] };
    const parsed = JSON.parse(raw) as AskSessionCacheFile;
    if (!parsed || !Array.isArray(parsed.entries)) return { entries: [] };
    return { entries: parsed.entries.slice(0, ASK_SESSION_MAX_ENTRIES) };
  } catch {
    return { entries: [] };
  }
}

function writeCache(cache: AskSessionCacheFile) {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.setItem(
      ASK_SESSION_CACHE_KEY,
      JSON.stringify({
        entries: cache.entries.slice(0, ASK_SESSION_MAX_ENTRIES),
      }),
    );
  } catch {
    /* quota / private mode */
  }
}

export function getSessionAskId(): string {
  if (typeof window === "undefined") return "ssr";
  try {
    const k = "ga-ask-session-id";
    let id = sessionStorage.getItem(k);
    if (!id) {
      id = `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
      sessionStorage.setItem(k, id);
    }
    return id;
  } catch {
    return "anon";
  }
}

/**
 * Lookup for mode switching: exact question + mode + project.
 * If several versioned entries exist, return the newest.
 * Never returns a result for a different question or mode.
 */
export function getCachedAskResult(params: {
  projectId: string;
  normalizedQuestion: string;
  searchMode: SearchMode;
}): AskCacheEntry | null {
  const q = normalizeAskQuestion(params.normalizedQuestion);
  if (!q || !params.projectId) return null;
  const identity = askCacheIdentity(params.projectId, q, params.searchMode);
  const matches = readCache().entries.filter(
    (e) =>
      askCacheIdentity(
        e.key.projectId,
        e.key.normalizedQuestion,
        e.key.searchMode,
      ) === identity,
  );
  if (!matches.length) return null;
  matches.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return matches[0]!;
}

/** Which modes have a stored result for this exact question + project. */
export function modesCachedForQuestion(params: {
  projectId: string;
  normalizedQuestion: string;
}): Set<SearchMode> {
  const q = normalizeAskQuestion(params.normalizedQuestion);
  const set = new Set<SearchMode>();
  if (!q || !params.projectId) return set;
  for (const e of readCache().entries) {
    if (
      e.key.projectId === params.projectId &&
      e.key.normalizedQuestion === q
    ) {
      set.add(e.key.searchMode);
    }
  }
  return set;
}

export function putCachedAskResult(params: {
  key: AskCacheKeyParts;
  result: AskQuestionResult;
}): void {
  const keyString = buildAskCacheKeyString(params.key);
  const entry: AskCacheEntry = {
    key: params.key,
    keyString,
    result: params.result,
    createdAt: new Date().toISOString(),
  };
  const cache = readCache();
  const rest = cache.entries.filter((e) => e.keyString !== keyString);
  writeCache({ entries: [entry, ...rest] });
}

/** Build cache key parts from a finished ask result (versions from server). */
export function cacheKeyFromAskResult(params: {
  projectId: string;
  sessionId: string;
  normalizedQuestion: string;
  searchMode: SearchMode;
  result: AskQuestionResult;
}): AskCacheKeyParts {
  return {
    projectId: params.projectId,
    sessionId: params.sessionId,
    normalizedQuestion: params.normalizedQuestion,
    searchMode: params.searchMode,
    indexVersion: params.result.indexPath ?? "",
    searchProfileVersion: params.result.searchProfileId ?? "",
    plannerPromptVersion:
      params.result.searchMode === "planned_rag"
        ? (params.result.promptVersion ?? "")
        : "",
    answerPromptVersion: params.result.promptVersion ?? "",
  };
}
