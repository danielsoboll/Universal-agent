import type { LocalProject } from "@/lib/localAuth/types";
import type { DomainProfile, DomainSearchProfile } from "@/lib/domain/types";
import {
  KnowledgeRetriever,
  type KnowledgeHit,
} from "@/lib/knowledge/knowledgeRetriever";
import {
  mapTargetTypesToKnowledgeUnitTypes,
  sanitizeMetadataFilters,
  type QueryPlan,
  type QueryPlanSubquery,
} from "@/lib/knowledge/queryPlanSchema";
import {
  fuseSubqueryHits,
  listAvailableKnowledgeUnitTypes,
  type AggregatedKnowledgeHit,
  type PlannedRetrievalResult,
} from "@/lib/knowledge/executeQueryPlan";

const BASELINE_SUBQUERY_ID = "baseline";
const MAX_PLANNED_SUBQUERIES = 4;

/**
 * planned_rag-only helpers. Do not call from the direct_rag path.
 * Baseline search uses the same KnowledgeRetriever.search contract as direct_rag.
 */

function normalizeSubqueryText(q: string): string {
  return q.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Cap at 4 and drop near-duplicate subquery texts. */
export function refinePlanSubqueries(plan: QueryPlan): QueryPlanSubquery[] {
  const seen = new Set<string>();
  const out: QueryPlanSubquery[] = [];
  for (const sq of plan.subqueries) {
    const key = normalizeSubqueryText(sq.query);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(sq);
    if (out.length >= MAX_PLANNED_SUBQUERIES) break;
  }
  return out.length > 0 ? out : plan.subqueries.slice(0, 1);
}

/**
 * Soften hard type filters: low planner confidence → no type filter.
 * Mapped types absent from the live index → no type filter.
 */
export function resolvePlannedTypeFilter(params: {
  targetTypes: string[];
  mapping: Record<string, string[] | undefined>;
  plannerConfidence: number;
  availableIndexTypes: string[];
}): string[] | undefined {
  if (params.plannerConfidence < 0.7) return undefined;
  const mapped = mapTargetTypesToKnowledgeUnitTypes(
    params.targetTypes,
    params.mapping,
  );
  if (!mapped?.length) return undefined;
  const available = new Set(params.availableIndexTypes);
  const present = mapped.filter((t) => available.has(t));
  if (present.length === 0) return undefined;
  return present;
}

/**
 * Fuse baseline (original question) + subquery lists.
 * Baseline hits get a protective boost so strong direct matches are not
 * displaced by weak multi-subquery RRF piles. Generic — no query terms.
 *
 * Important: fuseSubqueryHits overwrites combined_score with the RRF aggregate.
 * We therefore keep the original baseline lexical/hybrid scores separately
 * and use those for the protective boost.
 */
export function fuseBaselineAndSubqueries(params: {
  baselineHits: KnowledgeHit[];
  perSubquery: Array<{ subqueryId: string; hits: KnowledgeHit[] }>;
  finalLimit: number;
}): AggregatedKnowledgeHit[] {
  const baselineScoreById = new Map(
    params.baselineHits.map((h) => [h.search_document_id, h.combined_score]),
  );
  const baselineRankById = new Map(
    params.baselineHits.map((h) => [h.search_document_id, h.rank]),
  );

  const lists = [
    { subqueryId: BASELINE_SUBQUERY_ID, hits: params.baselineHits },
    ...params.perSubquery,
  ];
  const fused = fuseSubqueryHits(lists, Math.max(params.finalLimit * 2, 24));

  const scored = fused.map((h) => {
    const inBaseline = h.matched_subqueries.includes(BASELINE_SUBQUERY_ID);
    const plannedSupport = h.matched_subqueries.filter(
      (id) => id !== BASELINE_SUBQUERY_ID,
    ).length;
    const baselineScore = baselineScoreById.get(h.search_document_id) ?? 0;
    const baselineRank = baselineRankById.get(h.search_document_id);

    // RRF component (small) + strong weight on original direct hybrid score
    let aggregate = h.aggregate_score;
    if (inBaseline) {
      // Keep direct_rag strength dominant; RRF only as tie-breaker / multi-support
      aggregate = baselineScore + h.aggregate_score * 0.5;
      if (plannedSupport > 0) {
        aggregate += 0.25 * plannedSupport;
      }
      // Mild preference for higher baseline ranks (lower rank number)
      if (baselineRank != null) {
        aggregate += Math.max(0, (20 - baselineRank) * 0.05);
      }
    } else {
      // Subquery-only hits: keep them available but below solid baseline hits
      aggregate = h.aggregate_score + Math.min(h.exact_score + h.fulltext_score, 5) * 0.1;
      if (plannedSupport > 1) aggregate += 0.05 * plannedSupport;
    }
    return {
      ...h,
      aggregate_score: aggregate,
      combined_score: aggregate,
    };
  });

  scored.sort((a, b) => b.aggregate_score - a.aggregate_score);
  return scored
    .slice(0, params.finalLimit)
    .map((h, i) => ({ ...h, rank: i + 1 }));
}

export type PlannedRagDiagnostics = {
  baseline_top: Array<{
    rank: number;
    source_key: string;
    combined_score: number;
  }>;
  subquery_tops: Array<{
    subquery_id: string;
    query: string;
    type_filter: string[] | null;
    top: Array<{ rank: number; source_key: string; combined_score: number }>;
  }>;
  refined_subquery_count: number;
};

export type PlannedRagExecutionResult = PlannedRetrievalResult & {
  diagnostics: PlannedRagDiagnostics;
  refined_plan_subqueries: QueryPlanSubquery[];
};

/**
 * planned_rag retrieval:
 * 1) unchanged direct search on the original question (baseline)
 * 2) refined planner subqueries (additive)
 * 3) merge with baseline protection
 */
export async function executePlannedRagRetrieval(params: {
  project: LocalProject;
  originalQuestion: string;
  plan: QueryPlan;
  domainProfile: DomainProfile;
  searchProfile: DomainSearchProfile;
  limitPerSubquery?: number;
  finalLimit?: number;
}): Promise<PlannedRagExecutionResult> {
  const warnings: string[] = [];
  const finalLimit = params.finalLimit ?? 12;
  const limitPerSubquery = params.limitPerSubquery ?? 8;

  // --- 1) Baseline: same search contract as direct_rag ---
  const baseline = await KnowledgeRetriever.search({
    project: params.project,
    query: params.originalQuestion,
    limit: finalLimit,
    searchProfile: params.searchProfile,
  });
  warnings.push(...baseline.warnings.map((w) => `[baseline] ${w}`));

  const availableIndexTypes = await listAvailableKnowledgeUnitTypes(
    params.project,
  );
  const refined = refinePlanSubqueries(params.plan);
  const mapping = params.domainProfile.targetTypeToKnowledgeUnitType;
  const metaFields = params.searchProfile.metadataFields;
  const confidence = params.plan.planner_confidence ?? 0;

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
    if (
      sq.target_types.length > 0 &&
      typeFilter === undefined &&
      confidence >= 0.7
    ) {
      warnings.push(
        `[${sq.id}] Target-Type-Filter verworfen (keine Index-Typen für ${sq.target_types.join(", ")}).`,
      );
    } else if (confidence < 0.7 && sq.target_types.length > 0) {
      warnings.push(
        `[${sq.id}] Kein harter Target-Type-Filter (Planner-Confidence ${confidence.toFixed(2)} < 0.7).`,
      );
    }

    const meta = sanitizeMetadataFilters(sq.metadata_filters ?? {}, metaFields);
    const expand = sq.relation_expansion !== "none";

    const result = await KnowledgeRetriever.search({
      project: params.project,
      query: sq.query,
      limit: limitPerSubquery,
      filters: {
        knowledge_unit_types: typeFilter,
        metadata_filters: Object.keys(meta).length ? meta : undefined,
      },
      enableRelationExpansion: expand,
      searchProfile: params.searchProfile,
    });

    embeddingTokens += result.query_embedding_tokens;
    embeddingCost += result.query_embedding_cost;
    vectorActive = vectorActive || result.vector_search_active;
    warnings.push(...result.warnings.map((w) => `[${sq.id}] ${w}`));
    perSubquery.push({ subqueryId: sq.id, hits: result.hits });
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

  const hits = fuseBaselineAndSubqueries({
    baselineHits: baseline.hits,
    perSubquery,
    finalLimit,
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
    diagnostics: {
      baseline_top: baseline.hits.slice(0, 20).map((h) => ({
        rank: h.rank,
        source_key: h.source_key,
        combined_score: h.combined_score,
      })),
      subquery_tops: subqueryTops,
      refined_subquery_count: refined.length,
    },
  };
}
