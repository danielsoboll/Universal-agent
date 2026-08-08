/**
 * Optional Ask expansion: analyze only missing/stale method analyses
 * in the technical neighborhood of the current question.
 */
export type KnowledgeExpansionFailed = {
  source_key: string;
  error: string;
};

export type KnowledgeExpansionLayers = {
  preexisting: string[];
  newly_analyzed: string[];
  still_open: string[];
};

export type KnowledgeExpansionReport = {
  enabled: boolean;
  ran: boolean;
  budget: number;
  candidates_total: number;
  already_cached: number;
  analyzed_new: number;
  analyzed_source_keys: string[];
  deferred_source_keys: string[];
  failed: KnowledgeExpansionFailed[];
  duration_ms: number;
  re_ran_answer: boolean;
  layers: KnowledgeExpansionLayers;
  notes: string[];
};

export const DEFAULT_EXPAND_ANALYSIS_BUDGET = 10;
export const MAX_EXPAND_ANALYSIS_BUDGET = 25;

export function emptyKnowledgeExpansionReport(
  enabled: boolean,
): KnowledgeExpansionReport {
  return {
    enabled,
    ran: false,
    budget: DEFAULT_EXPAND_ANALYSIS_BUDGET,
    candidates_total: 0,
    already_cached: 0,
    analyzed_new: 0,
    analyzed_source_keys: [],
    deferred_source_keys: [],
    failed: [],
    duration_ms: 0,
    re_ran_answer: false,
    layers: { preexisting: [], newly_analyzed: [], still_open: [] },
    notes: [],
  };
}

export function clampExpandBudget(
  raw: number | undefined,
  opts?: { allowElevated?: boolean },
): number {
  const base = raw ?? DEFAULT_EXPAND_ANALYSIS_BUDGET;
  const max = opts?.allowElevated
    ? MAX_EXPAND_ANALYSIS_BUDGET
    : DEFAULT_EXPAND_ANALYSIS_BUDGET;
  if (!Number.isFinite(base) || base < 1) return DEFAULT_EXPAND_ANALYSIS_BUDGET;
  return Math.min(Math.floor(base), max);
}
