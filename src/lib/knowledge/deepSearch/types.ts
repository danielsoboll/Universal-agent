/**
 * Query Understanding + Deep Search types (KI-Tiefensuche only).
 */
export const QUERY_UNDERSTANDING_PROMPT_VERSION = "query-understanding-v1";

export const DEEP_SEARCH_INTENTS = [
  "ENTITY_LOOKUP",
  "ENTITY_USAGE",
  "PROCESS_EXPLANATION",
  "VERIFY_AND_EXPLAIN_PROCESS",
  "COMPARISON",
  "IMPACT_ANALYSIS",
  "VALUE_EXPLANATION",
  "TRACE",
  "VERIFICATION",
] as const;

export type DeepSearchIntent = (typeof DEEP_SEARCH_INTENTS)[number];

export const PREFERRED_SEARCH_PLANS = [
  "TECHNICAL_SYMBOL_TO_PROCESS",
  "MASTER_FIELD_TO_PROCESS",
  "CONTROL_TABLE_TO_PROCESS",
  "GENERIC_MULTI_SOURCE",
  "ENTITY_USAGE_EXPAND",
  "TRACE_CHAIN",
  "COMPARISON_DUAL",
  "IMPACT_FANOUT",
  "VALUE_TO_FIELD",
  "VERIFICATION_CHECK",
] as const;

export type PreferredSearchPlan = (typeof PREFERRED_SEARCH_PLANS)[number];

export type UserHypothesis = {
  text: string;
  status: "TO_BE_VERIFIED" | "ASSUMED" | "REJECTED_AS_FACT";
  confidence: number;
};

export type AssumedObjectType = {
  type: string;
  confidence: "low" | "medium" | "high";
  raw?: string | null;
};

export type QueryUnderstanding = {
  original_question: string;
  intent: DeepSearchIntent;
  technical_tokens: string[];
  business_concepts: string[];
  organization_context: string[];
  process_context: string[];
  user_hypotheses: UserHypothesis[];
  assumed_object_types: AssumedObjectType[];
  /** @deprecated use assumed_object_types — kept for schema clarity in logs */
  user_assumed_type?: string;
  assumed_type_confidence?: "low" | "medium" | "high";
  requested_output: string[];
  preferred_search_plan: PreferredSearchPlan;
  search_plan_steps: string[];
  irrelevant_question_words: string[];
  warnings: string[];
  model: string;
  prompt_version: string;
  confidence: number;
  token_usage: { input: number; output: number };
};

export type ModeRunMetrics = {
  run_id: string;
  runtime_ms: number;
  evidence_count: number;
  source_types: string[];
  coverage: Record<string, number | string>;
  cost: number;
  query_count: number;
  documents_searched: number;
  tokens: { input: number; output: number; embedding: number };
  status: string;
};

export type ModeComparison = {
  question: string;
  direct_search: ModeRunMetrics;
  deep_search: ModeRunMetrics;
};
