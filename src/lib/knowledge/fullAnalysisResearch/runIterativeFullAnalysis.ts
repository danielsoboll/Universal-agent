/**
 * Iterative Vollanalyse research state machine.
 * Only used when searchMode === "full_analysis".
 */
import type { LocalProject } from "@/lib/localAuth/types";
import type { DomainProfile, DomainSearchProfile } from "@/lib/domain/types";
import type { QueryPlan } from "@/lib/knowledge/queryPlanSchema";
import type { KnowledgeHit } from "@/lib/knowledge/knowledgeRetriever";
import {
  executeFullAnalysisRetrieval,
} from "@/lib/knowledge/executeFullAnalysis";
import type { PlannedRagExecutionResult } from "@/lib/knowledge/executePlannedRag";
import { runAnalysisPlanner } from "@/lib/knowledge/fullAnalysisResearch/analysisPlanner";
import {
  measureEvidenceDelta,
  mergeHits,
  snapshotFromHits,
  summarizeEvidenceForPlanner,
} from "@/lib/knowledge/fullAnalysisResearch/evidencePool";
import { executeResearchActions } from "@/lib/knowledge/fullAnalysisResearch/executeResearchActions";
import {
  DEFAULT_FULL_ANALYSIS_RESEARCH_BUDGETS,
  type FullAnalysisResearchBudgets,
  type FullAnalysisResearchReport,
  type ResearchIterationTrace,
} from "@/lib/knowledge/fullAnalysisResearch/types";
import { AI_CONFIG } from "@/lib/ai/config";

// Re-export for callers
export type { PlannedRagExecutionResult };

function estimateCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const pricing = AI_CONFIG.pricingUsdPer1M[model];
  if (!pricing) return 0;
  return (
    (inputTokens / 1_000_000) * pricing.input +
    (outputTokens / 1_000_000) * pricing.output
  );
}

function extractSeeds(hits: KnowledgeHit[], question: string): string[] {
  const seeds: string[] = [];
  const seen = new Set<string>();
  const push = (s: string) => {
    const t = s.trim();
    if (!t || seen.has(t.toUpperCase())) return;
    seen.add(t.toUpperCase());
    seeds.push(t);
  };
  for (const tok of question.split(/[^A-Za-z0-9_/]+/)) {
    if (tok.length >= 3) push(tok);
  }
  for (const h of hits.slice(0, 24)) {
    if (h.object_name) push(h.object_name);
    if (h.subobject_name) push(`${h.object_name}.${h.subobject_name}`);
    for (const t of [...h.tables_read, ...h.tables_written].slice(0, 4)) push(t);
    for (const m of h.called_methods.slice(0, 3)) push(m);
  }
  return seeds.slice(0, 40);
}

export type RunIterativeFullAnalysisParams = {
  project: LocalProject;
  originalQuestion: string;
  plan: QueryPlan;
  domainProfile: DomainProfile;
  searchProfile: DomainSearchProfile;
  budgets?: Partial<FullAnalysisResearchBudgets>;
  limitPerSubquery?: number;
  finalLimit?: number;
  runId?: string;
  systemId?: string;
  onProgress?: (msg: string) => void;
};

export type RunIterativeFullAnalysisResult = PlannedRagExecutionResult & {
  research: FullAnalysisResearchReport;
};

export async function runIterativeFullAnalysis(
  params: RunIterativeFullAnalysisParams,
): Promise<RunIterativeFullAnalysisResult> {
  const budgets: FullAnalysisResearchBudgets = {
    ...DEFAULT_FULL_ANALYSIS_RESEARCH_BUDGETS,
    ...params.budgets,
  };
  const log = (msg: string) => params.onProgress?.(msg);

  const iterations: ResearchIterationTrace[] = [];
  let known_claims: string[] = [];
  let open_questions: string[] = [];
  let openai_calls = 0;
  let input_tokens = 0;
  let output_tokens = 0;
  let new_method_analyses_total = 0;
  let stop_reason = "max_iterations";

  // ── Iteration 1: baseline exhaustive retrieval ──────────────────────────
  log("Vollanalyse Iteration 1: Retrieval / Seeds / Evidence…");
  const base = await executeFullAnalysisRetrieval({
    project: params.project,
    originalQuestion: params.originalQuestion,
    plan: params.plan,
    domainProfile: params.domainProfile,
    searchProfile: params.searchProfile,
    limitPerSubquery: params.limitPerSubquery,
    finalLimit: params.finalLimit,
    runId: params.runId,
  });

  let hits: KnowledgeHit[] = base.hits;
  let document_count = base.document_count;
  let vector_search_active = base.vector_search_active;
  let index_path = base.index_path;
  let query_embedding_tokens = base.query_embedding_tokens;
  let query_embedding_cost = base.query_embedding_cost;
  const warnings = [...base.warnings];
  let refined_plan_subqueries = base.refined_plan_subqueries;
  let subquery_count = base.subquery_count;
  let run_id = base.run_id;
  let diagnostics = base.diagnostics;
  let run_debug = base.run_debug;

  let poolSnap = snapshotFromHits(hits, { knownClaims: known_claims });
  const seeds = extractSeeds(hits, params.originalQuestion);

  for (let iter = 1; iter <= budgets.max_iterations; iter++) {
    const analysesLeft =
      budgets.max_new_method_analyses - new_method_analyses_total;
    const openaiLeft = budgets.max_openai_calls - openai_calls;

    if (openaiLeft <= 0) {
      stop_reason = "budget_openai_calls";
      iterations.push({
        iteration: iter,
        seeds,
        evidence_source_keys: hits.map((h) => h.source_key).slice(0, 80),
        evidence_count: hits.length,
        planner: null,
        open_questions,
        next_actions: [],
        delta: null,
        new_analyses: [],
        stop_reason,
        openai_calls_this_iteration: 0,
        tokens_this_iteration: { input: 0, output: 0 },
      });
      break;
    }
    if (
      budgets.max_estimated_cost_usd > 0 &&
      estimateCostUsd(AI_CONFIG.chatModel, input_tokens, output_tokens) >=
        budgets.max_estimated_cost_usd
    ) {
      stop_reason = "budget_cost";
      break;
    }
    if (
      budgets.max_estimated_tokens > 0 &&
      input_tokens + output_tokens >= budgets.max_estimated_tokens
    ) {
      stop_reason = "budget_tokens";
      break;
    }

    log(`Vollanalyse Iteration ${iter}: Analysis-Planner…`);
    const plannerResult = await runAnalysisPlanner({
      question: params.originalQuestion,
      iteration: iter,
      evidenceSummary: summarizeEvidenceForPlanner(hits),
      seeds,
      previousOpenQuestions: open_questions,
      previousKnownClaims: known_claims,
      remainingBudgets: {
        iterations_left: budgets.max_iterations - iter,
        analyses_left: analysesLeft,
        openai_calls_left: openaiLeft - 1,
      },
    });
    openai_calls += 1;
    input_tokens += plannerResult.tokens.input;
    output_tokens += plannerResult.tokens.output;

    const decision = plannerResult.decision;
    known_claims = decision.known_claims.length
      ? decision.known_claims
      : known_claims;
    open_questions = decision.open_questions;

    const iterTrace: ResearchIterationTrace = {
      iteration: iter,
      seeds: seeds.slice(0, 30),
      evidence_source_keys: hits.map((h) => h.source_key).slice(0, 80),
      evidence_count: hits.length,
      planner: decision,
      open_questions: decision.open_questions,
      next_actions: decision.next_actions,
      delta: null,
      new_analyses: [],
      openai_calls_this_iteration: 1,
      tokens_this_iteration: { ...plannerResult.tokens },
    };

    if (decision.status === "COMPLETE") {
      iterTrace.stop_reason = "planner_complete";
      iterations.push(iterTrace);
      stop_reason = "planner_complete";
      log(`Iteration ${iter}: Planner COMPLETE.`);
      break;
    }

    if (decision.next_actions.length === 0) {
      iterTrace.stop_reason = "no_actions";
      iterations.push(iterTrace);
      stop_reason = "no_actions";
      break;
    }

    if (iter >= budgets.max_iterations) {
      iterTrace.stop_reason = "max_iterations";
      iterations.push(iterTrace);
      stop_reason = "max_iterations";
      break;
    }

    // Execute actions → measure delta
    const before = snapshotFromHits(hits, {
      analysisKeys: [...poolSnap.analysis_keys],
      knownClaims: known_claims,
    });

    log(
      `Iteration ${iter}: Actions ${decision.next_actions.map((a) => a.type).join(", ")}…`,
    );
    const executed = await executeResearchActions({
      project: params.project,
      question: params.originalQuestion,
      searchProfile: params.searchProfile,
      actions: decision.next_actions,
      analysesBudgetLeft: analysesLeft,
      openaiCallsLeft: budgets.max_openai_calls - openai_calls,
      systemId: params.systemId,
    });
    warnings.push(...executed.notes.map((n) => `[research_i${iter}] ${n}`));
    openai_calls += executed.openai_calls;
    iterTrace.openai_calls_this_iteration += executed.openai_calls;
    query_embedding_tokens += executed.embedding_tokens;
    query_embedding_cost += executed.embedding_cost;
    new_method_analyses_total += executed.new_analyses.length;
    iterTrace.new_analyses = executed.new_analyses;

    hits = mergeHits(hits, executed.hits);
    document_count = Math.max(document_count, hits.length);

    const after = snapshotFromHits(hits, {
      analysisKeys: [
        ...poolSnap.analysis_keys,
        ...executed.new_analyses,
      ],
      knownClaims: known_claims,
    });
    const delta = measureEvidenceDelta(before, after);
    iterTrace.delta = delta;
    poolSnap = after;

    if (!delta.has_knowledge_gain) {
      iterTrace.stop_reason = "no_knowledge_gain";
      iterations.push(iterTrace);
      stop_reason = "no_knowledge_gain";
      log(`Iteration ${iter}: kein Knowledge Gain — Stop.`);
      break;
    }

    iterations.push(iterTrace);
    // continue to next iteration → planner again
  }

  const research: FullAnalysisResearchReport = {
    schema_version: 1,
    enabled: true,
    budgets,
    iterations,
    stop_reason,
    known_claims,
    open_questions,
    stats: {
      iterations_run: iterations.length,
      openai_calls,
      new_method_analyses: new_method_analyses_total,
      input_tokens,
      output_tokens,
      estimated_cost_usd: estimateCostUsd(
        AI_CONFIG.chatModel,
        input_tokens,
        output_tokens,
      ),
    },
  };

  return {
    hits: hits.map((h) => {
      const agg = h as KnowledgeHit & {
        matched_subqueries?: string[];
        source_ranks?: number[];
        aggregate_score?: number;
        evidence_coverage?: string[];
      };
      return {
        ...h,
        matched_subqueries: agg.matched_subqueries ?? ["research"],
        source_ranks: agg.source_ranks ?? [h.rank],
        aggregate_score: agg.aggregate_score ?? h.combined_score,
        evidence_coverage: agg.evidence_coverage ?? [],
      };
    }),
    document_count,
    vector_search_active,
    index_path,
    query_embedding_tokens,
    query_embedding_cost,
    warnings,
    refined_plan_subqueries,
    subquery_count,
    run_id,
    diagnostics,
    run_debug,
    planner_version: base.planner_version,
    topic_grounded_hits: base.topic_grounded_hits,
    research,
  };
}
