/**
 * SEARCH_BUDGET_GATE — stages before expensive OpenAI analysis.
 * Not a question resolver: only budgets retrieval/analysis escalation.
 */

export type SearchBudgetStage =
  | "LOCAL_EXACT"
  | "EXISTING_RETRIEVAL"
  | "ON_DEMAND_CODE_ANALYSIS"
  | "DEEP_ANALYSIS";

/** Communication / interface object kinds (generic, no customer names). */
export const COMMUNICATION_OBJECT_TYPES = [
  "partner_profile",
  "logical_system",
  "port",
  "rfc_destination",
  "http_url",
  "proxy",
  "webservice",
  "message_type",
  "idoc_type",
  "output_type",
  "output_type_text",
  "output_processing",
  "partner_function",
] as const;

export type CommunicationObjectType =
  (typeof COMMUNICATION_OBJECT_TYPES)[number];

export type NamedExternalEntity = {
  raw: string;
  normalized: string;
  kind:
    | "application"
    | "interface"
    | "company"
    | "portal"
    | "system"
    | "partner"
    | "technical_symbol";
};

export type SearchBudgetDiagnostics = {
  stage_reached: SearchBudgetStage;
  named_entity: string | null;
  technical_anchors: string[];
  local_exact_hit_count: number;
  communication_hit_count: number;
  retrieval_hit_count: number;
  cache_hits: number;
  /** New OpenAI calls in this ask (embedding / synthesis / analysis). */
  new_openai_calls: number;
  estimated_input_tokens: number;
  on_demand_candidates: number;
  on_demand_limit: number;
  on_demand_executed: number;
  escalation_reason: string | null;
  blocked_reason: string | null;
  notes: string[];
};

export const DEFAULT_ON_DEMAND_CODE_UNIT_LIMIT = 5;

export function emptySearchBudgetDiagnostics(
  stage: SearchBudgetStage = "LOCAL_EXACT",
): SearchBudgetDiagnostics {
  return {
    stage_reached: stage,
    named_entity: null,
    technical_anchors: [],
    local_exact_hit_count: 0,
    communication_hit_count: 0,
    retrieval_hit_count: 0,
    cache_hits: 0,
    new_openai_calls: 0,
    estimated_input_tokens: 0,
    on_demand_candidates: 0,
    on_demand_limit: DEFAULT_ON_DEMAND_CODE_UNIT_LIMIT,
    on_demand_executed: 0,
    escalation_reason: null,
    blocked_reason: null,
    notes: [],
  };
}
