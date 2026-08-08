/**
 * Iterative Vollanalyse research — types & budgets.
 * Isolated from direct_rag / planned_rag / deep_search.
 */

export type ResearchActionType =
  | "EXPAND_GRAPH"
  | "ANALYZE_METHODS"
  | "SEARCH_CONFIG"
  | "SEARCH_DDIC"
  | "SEARCH_MASTERDATA"
  | "SEARCH_CODE";

export type ResearchPlannerStatus = "COMPLETE" | "INCOMPLETE";

export type ResearchNextAction = {
  type: ResearchActionType;
  targets: string[];
  reason: string;
};

export type ResearchPlannerDecision = {
  status: ResearchPlannerStatus;
  known_claims: string[];
  open_questions: string[];
  next_actions: ResearchNextAction[];
};

export type FullAnalysisResearchBudgets = {
  max_iterations: number;
  max_new_method_analyses: number;
  max_openai_calls: number;
  /** Soft cap; 0 = disabled. */
  max_estimated_tokens: number;
  /** Soft cap; 0 = disabled. */
  max_estimated_cost_usd: number;
};

export const DEFAULT_FULL_ANALYSIS_RESEARCH_BUDGETS: FullAnalysisResearchBudgets =
  {
    max_iterations: 3,
    max_new_method_analyses: 20,
    max_openai_calls: 6,
    max_estimated_tokens: 0,
    max_estimated_cost_usd: 0,
  };

export type EvidenceDelta = {
  new_evidence_docs: number;
  new_method_analyses: number;
  new_relations: number;
  new_nodes: number;
  new_confirmed_claims: number;
  /** True if any of the above > 0 (or meaningful claim/open-question change). */
  has_knowledge_gain: boolean;
};

export type ResearchIterationTrace = {
  iteration: number;
  seeds: string[];
  evidence_source_keys: string[];
  evidence_count: number;
  planner: ResearchPlannerDecision | null;
  open_questions: string[];
  next_actions: ResearchNextAction[];
  delta: EvidenceDelta | null;
  new_analyses: string[];
  stop_reason?: string;
  openai_calls_this_iteration: number;
  tokens_this_iteration: { input: number; output: number };
};

export type FullAnalysisResearchReport = {
  schema_version: 1;
  enabled: true;
  budgets: FullAnalysisResearchBudgets;
  iterations: ResearchIterationTrace[];
  stop_reason: string;
  known_claims: string[];
  open_questions: string[];
  stats: {
    iterations_run: number;
    openai_calls: number;
    new_method_analyses: number;
    input_tokens: number;
    output_tokens: number;
    estimated_cost_usd: number;
  };
};

export type ResearchPoolSnapshot = {
  evidence_keys: Set<string>;
  analysis_keys: Set<string>;
  relation_keys: Set<string>;
  node_keys: Set<string>;
  known_claims: Set<string>;
};
