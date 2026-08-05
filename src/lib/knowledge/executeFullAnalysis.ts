/**
 * full_analysis-only retrieval — broader recall than planned_rag / direct_rag.
 * Does not alter defaults of those modes. Isolated per question (no chat memory).
 */

import type { LocalProject } from "@/lib/localAuth/types";
import type { DomainProfile, DomainSearchProfile } from "@/lib/domain/types";
import {
  KnowledgeRetriever,
  type KnowledgeHit,
} from "@/lib/knowledge/knowledgeRetriever";
import type { QueryPlan, QueryPlanSubquery } from "@/lib/knowledge/queryPlanSchema";
import {
  listAvailableKnowledgeUnitTypes,
  type AggregatedKnowledgeHit,
} from "@/lib/knowledge/executeQueryPlan";
import {
  fuseBaselineAndSubqueries,
  refinePlanSubqueries,
  resolvePlannedTypeFilter,
  type PlannedRagDiagnostics,
  type PlannedRagExecutionResult,
} from "@/lib/knowledge/executePlannedRag";
import {
  PLANNED_RAG_PLANNER_VERSION,
  buildPlannedRunDebugLog,
  createPlannedRagRunState,
  groundPlannedCandidates,
  logPlannedRunDebug,
  synthesisHitsFromTopicGrounding,
} from "@/lib/knowledge/plannedTopicGrounding";
import { FULL_ANALYSIS_VERSION } from "@/lib/knowledge/askModeVersions";

export { FULL_ANALYSIS_VERSION };

const BASELINE_SUBQUERY_ID = "baseline";
const MAX_FULL_SUBQUERIES = 6;

/** Knowledge-unit type buckets for coverage sweeps (broader than normal top-k). */
const TYPE_BUCKETS: Array<{ id: string; types: string[]; label: string }> = [
  {
    id: "bucket_code",
    types: ["code_unit", "code_unit_analysis"],
    label: "Code / Analysen",
  },
  {
    id: "bucket_table",
    types: [
      "control_table",
      "control_table_analysis",
      "table_profile",
      "canonical_table_row",
    ],
    label: "Tabellen",
  },
  {
    id: "bucket_rule",
    types: ["business_rule"],
    label: "Regeln",
  },
  {
    id: "bucket_analysis",
    types: ["code_table_interpretation", "dynamic_table_access"],
    label: "Interpretationen",
  },
];

function refineFullSubqueries(plan: QueryPlan): QueryPlanSubquery[] {
  const seen = new Set<string>();
  const out: QueryPlanSubquery[] = [];
  for (const sq of plan.subqueries) {
    const key = sq.query.trim().toLowerCase().replace(/\s+/g, " ");
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(sq);
    if (out.length >= MAX_FULL_SUBQUERIES) break;
  }
  return out.length > 0 ? out : refinePlanSubqueries(plan);
}

/**
 * Exhaustive retrieval for Vollanalyse:
 * 1) Broad baseline on the original question
 * 2) Up to 6 planner subqueries (additive)
 * 3) Type-bucket coverage searches (code/tables/rules/analyses)
 * 4) Soft topic grounding — keep confirmed + possible; higher final limit
 *
 * No prior Q/A or session memory.
 */
export async function executeFullAnalysisRetrieval(params: {
  project: LocalProject;
  originalQuestion: string;
  plan: QueryPlan;
  domainProfile: DomainProfile;
  searchProfile: DomainSearchProfile;
  limitPerSubquery?: number;
  finalLimit?: number;
  runId?: string;
}): Promise<PlannedRagExecutionResult> {
  const run = createPlannedRagRunState(params.originalQuestion, params.runId);
  const warnings: string[] = [];
  const finalLimit = params.finalLimit ?? 40;
  const limitPerSubquery = params.limitPerSubquery ?? 16;

  const baseline = await KnowledgeRetriever.search({
    project: params.project,
    query: params.originalQuestion,
    limit: Math.max(finalLimit, 32),
    searchProfile: params.searchProfile,
    enableRelationExpansion: true,
  });
  warnings.push(...baseline.warnings.map((w) => `[baseline] ${w}`));

  const availableIndexTypes = await listAvailableKnowledgeUnitTypes(
    params.project,
  );
  const availableSet = new Set(availableIndexTypes);
  const refined = refineFullSubqueries(params.plan);
  run.subqueries = refined.map((sq) => ({ id: sq.id, query: sq.query }));
  const mapping = params.domainProfile.targetTypeToKnowledgeUnitType;
  // Soften type filters for coverage: treat confidence as low unless very high
  const confidence = Math.min(params.plan.planner_confidence ?? 0, 0.65);

  const perSubquery: Array<{ subqueryId: string; hits: KnowledgeHit[] }> = [];
  const subqueryTops: PlannedRagDiagnostics["subquery_tops"] = [];
  let embeddingTokens = baseline.query_embedding_tokens;
  let embeddingCost = baseline.query_embedding_cost;
  let vectorActive = baseline.vector_search_active;

  for (const sq of refined) {
    const typeFilter = resolvePlannedTypeFilter({
      targetTypes: sq.target_types,
      mapping,
      plannerConfidence: confidence,
      availableIndexTypes,
    });

    const result = await KnowledgeRetriever.search({
      project: params.project,
      query: sq.query,
      limit: limitPerSubquery,
      filters: {
        knowledge_unit_types: typeFilter,
      },
      enableRelationExpansion: true,
      searchProfile: params.searchProfile,
    });

    embeddingTokens += result.query_embedding_tokens;
    embeddingCost += result.query_embedding_cost;
    vectorActive = vectorActive || result.vector_search_active;
    warnings.push(...result.warnings.map((w) => `[${sq.id}] ${w}`));
    perSubquery.push({
      subqueryId: sq.id,
      hits: result.hits.map((h) => ({ ...h })),
    });
    subqueryTops.push({
      subquery_id: sq.id,
      query: sq.query,
      type_filter: typeFilter ?? null,
      top: result.hits.slice(0, 10).map((h) => ({
        rank: h.rank,
        source_key: h.source_key,
        combined_score: h.combined_score,
      })),
    });
  }

  // Type-bucket coverage sweeps — only types present in the live index
  for (const bucket of TYPE_BUCKETS) {
    const present = bucket.types.filter((t) => availableSet.has(t));
    if (present.length === 0) continue;
    const result = await KnowledgeRetriever.search({
      project: params.project,
      query: params.originalQuestion,
      limit: Math.min(12, limitPerSubquery),
      filters: { knowledge_unit_types: present },
      enableRelationExpansion: true,
      searchProfile: params.searchProfile,
    });
    embeddingTokens += result.query_embedding_tokens;
    embeddingCost += result.query_embedding_cost;
    vectorActive = vectorActive || result.vector_search_active;
    if (result.hits.length === 0) continue;
    warnings.push(
      `[${bucket.id}] ${result.hits.length} Treffer (${bucket.label}).`,
    );
    perSubquery.push({
      subqueryId: bucket.id,
      hits: result.hits.map((h) => ({ ...h })),
    });
    subqueryTops.push({
      subquery_id: bucket.id,
      query: `${params.originalQuestion} [${bucket.label}]`,
      type_filter: present,
      top: result.hits.slice(0, 8).map((h) => ({
        rank: h.rank,
        source_key: h.source_key,
        combined_score: h.combined_score,
      })),
    });
  }

  const fused = fuseBaselineAndSubqueries({
    baselineHits: baseline.hits.map((h) => ({ ...h })),
    perSubquery,
    finalLimit: Math.max(finalLimit * 2, 48),
  });
  run.candidates_before = fused.map((h) => ({ ...h }));

  const grounded = groundPlannedCandidates({
    run_id: run.run_id,
    question: params.originalQuestion,
    plan: params.plan,
    candidates: fused,
  });
  const { synthesis_hits } = synthesisHitsFromTopicGrounding(grounded.kept);
  const limited = synthesis_hits.slice(0, finalLimit).map((h, i) => ({
    ...h,
    rank: i + 1,
  }));

  run.candidates_after = limited;
  run.excluded = grounded.excluded;
  run.evidence_ids = limited.map((h) => h.search_document_id);
  run.synthesis_context_ids = limited.map((h) => h.search_document_id);

  const run_debug = buildPlannedRunDebugLog({
    state: run,
    topic_concepts: grounded.topic_concepts,
    topic_phrases: grounded.topic_phrases,
    entity_anchors: grounded.entity_anchors,
  });
  logPlannedRunDebug({
    ...run_debug,
    // Tag log for ops; planned_rag logger still used
  });
  console.info(
    "[full_analysis:run]",
    JSON.stringify({
      run_id: run.run_id,
      hit_count: limited.length,
      subquery_count: 1 + refined.length + TYPE_BUCKETS.length,
      version: FULL_ANALYSIS_VERSION,
      planner_version: PLANNED_RAG_PLANNER_VERSION,
    }),
  );

  if (grounded.excluded.length > 0) {
    warnings.push(
      `[topic_ground] ${grounded.excluded.length} fachfremde Kandidaten entfernt.`,
    );
  }

  const hits: AggregatedKnowledgeHit[] = limited.map((h) => {
    const { topic_status: _ts, topic_reason: _tr, topic_matched: _tm, ...rest } =
      h;
    void _ts;
    void _tr;
    void _tm;
    const agg = rest as AggregatedKnowledgeHit;
    return {
      ...agg,
      matched_subqueries: agg.matched_subqueries ?? [BASELINE_SUBQUERY_ID],
      source_ranks: agg.source_ranks ?? [agg.rank],
      aggregate_score: agg.aggregate_score ?? agg.combined_score,
      evidence_coverage: agg.evidence_coverage ?? [],
    };
  });

  return {
    hits,
    document_count: baseline.document_count,
    subquery_count: 1 + refined.length,
    vector_search_active: vectorActive,
    index_path: baseline.index_path,
    query_embedding_tokens: embeddingTokens,
    query_embedding_cost: embeddingCost,
    warnings: [...new Set(warnings)],
    refined_plan_subqueries: refined,
    run_id: run.run_id,
    topic_grounded_hits: limited,
    run_debug,
    planner_version: PLANNED_RAG_PLANNER_VERSION,
    diagnostics: {
      baseline_top: baseline.hits.slice(0, 20).map((h) => ({
        rank: h.rank,
        source_key: h.source_key,
        combined_score: h.combined_score,
      })),
      subquery_tops: subqueryTops,
      refined_subquery_count: refined.length,
      topic_excluded: grounded.excluded,
      topic_statuses: grounded.kept.map((h) => ({
        source_key: h.source_key,
        topic_status: h.topic_status,
        reason: h.topic_reason,
      })),
    },
  };
}
