import type { LocalProject } from "@/lib/localAuth/types";
import type { DomainProfile } from "@/lib/domain/types";
import type { DomainSearchProfile } from "@/lib/domain/types";
import { KnowledgeRetriever, type KnowledgeHit } from "@/lib/knowledge/knowledgeRetriever";
import {
  mapTargetTypesToKnowledgeUnitTypes,
  sanitizeMetadataFilters,
  type QueryPlan,
} from "@/lib/knowledge/queryPlanSchema";

export type AggregatedKnowledgeHit = KnowledgeHit & {
  matched_subqueries: string[];
  source_ranks: number[];
  aggregate_score: number;
  evidence_coverage: string[];
};

export type PlannedRetrievalResult = {
  hits: AggregatedKnowledgeHit[];
  document_count: number;
  subquery_count: number;
  vector_search_active: boolean;
  index_path: string;
  query_embedding_tokens: number;
  query_embedding_cost: number;
  warnings: string[];
};

function evidenceCoverageForHit(hit: KnowledgeHit): string[] {
  const cov: string[] = [];
  if (hit.evidence?.length || hit.evidence_refs?.length) cov.push("code");
  if (hit.hardcoded_values?.length) cov.push("hardcoding");
  if (hit.tables_read?.length || hit.tables_written?.length) {
    cov.push("table_definition");
  }
  if (hit.knowledge_unit_type === "control_table_row") cov.push("table_row");
  if (hit.called_methods?.length) cov.push("callee_relation");
  if (hit.facts?.some((f) => /PREF_|R_|=/.test(f))) cov.push("field_assignment");
  if ((hit.inferences ?? []).some((i) => /kommentar|comment/i.test(i))) {
    cov.push("comment");
  }
  return [...new Set(cov)];
}

/**
 * Reciprocal Rank Fusion across subquery result lists.
 * Documents appearing in multiple subqueries get higher fused scores.
 */
export function fuseSubqueryHits(
  perSubquery: Array<{ subqueryId: string; hits: KnowledgeHit[] }>,
  limit: number,
): AggregatedKnowledgeHit[] {
  const K = 60;
  type Acc = {
    hit: KnowledgeHit;
    rrf: number;
    matched: string[];
    ranks: number[];
    bestCombined: number;
  };
  const byId = new Map<string, Acc>();

  for (const { subqueryId, hits } of perSubquery) {
    hits.forEach((h, idx) => {
      const rank = idx + 1;
      const prev = byId.get(h.search_document_id);
      const add = 1 / (K + rank);
      if (!prev) {
        byId.set(h.search_document_id, {
          hit: h,
          rrf: add,
          matched: [subqueryId],
          ranks: [rank],
          bestCombined: h.combined_score,
        });
      } else {
        prev.rrf += add;
        prev.matched.push(subqueryId);
        prev.ranks.push(rank);
        if (h.combined_score > prev.bestCombined) {
          prev.bestCombined = h.combined_score;
          prev.hit = h;
        }
      }
    });
  }

  const fused = [...byId.values()]
    .map((a) => {
      const multiBonus = 1 + 0.15 * Math.max(0, a.matched.length - 1);
      const aggregate_score = a.rrf * multiBonus + a.bestCombined * 0.01;
      const out: AggregatedKnowledgeHit = {
        ...a.hit,
        matched_subqueries: [...new Set(a.matched)],
        source_ranks: a.ranks,
        aggregate_score,
        evidence_coverage: evidenceCoverageForHit(a.hit),
        combined_score: aggregate_score,
      };
      return out;
    })
    .sort((a, b) => b.aggregate_score - a.aggregate_score)
    .slice(0, limit);

  return fused.map((h, i) => ({ ...h, rank: i + 1 }));
}

export async function executeQueryPlan(params: {
  project: LocalProject;
  plan: QueryPlan;
  domainProfile: DomainProfile;
  searchProfile: DomainSearchProfile;
  limitPerSubquery?: number;
  finalLimit?: number;
}): Promise<PlannedRetrievalResult> {
  const warnings: string[] = [];
  const perSubquery: Array<{ subqueryId: string; hits: KnowledgeHit[] }> = [];
  let document_count = 0;
  let index_path = "";
  let embeddingTokens = 0;
  let embeddingCost = 0;
  let vectorActive = false;

  const mapping = params.domainProfile.targetTypeToKnowledgeUnitType;
  const metaFields = params.searchProfile.metadataFields;

  for (const sq of params.plan.subqueries) {
    const kuTypes = mapTargetTypesToKnowledgeUnitTypes(sq.target_types, mapping);
    const meta = sanitizeMetadataFilters(sq.metadata_filters ?? {}, metaFields);
    const expand = sq.relation_expansion !== "none";

    const result = await KnowledgeRetriever.search({
      project: params.project,
      query: sq.query,
      limit: params.limitPerSubquery ?? 8,
      filters: {
        knowledge_unit_types: kuTypes,
        metadata_filters: Object.keys(meta).length ? meta : undefined,
      },
      enableRelationExpansion: expand,
      searchProfile: params.searchProfile,
    });

    document_count = result.document_count;
    index_path = result.index_path;
    embeddingTokens += result.query_embedding_tokens;
    embeddingCost += result.query_embedding_cost;
    vectorActive = vectorActive || result.vector_search_active;
    warnings.push(...result.warnings.map((w) => `[${sq.id}] ${w}`));
    perSubquery.push({ subqueryId: sq.id, hits: result.hits });
  }

  const hits = fuseSubqueryHits(perSubquery, params.finalLimit ?? 12);

  return {
    hits,
    document_count,
    subquery_count: params.plan.subqueries.length,
    vector_search_active: vectorActive,
    index_path,
    query_embedding_tokens: embeddingTokens,
    query_embedding_cost: embeddingCost,
    warnings: [...new Set(warnings)],
  };
}

/** Distinct knowledge_unit_types present in the active index (for planner prompt). */
export async function listAvailableKnowledgeUnitTypes(
  project: LocalProject,
): Promise<string[]> {
  const status = KnowledgeRetriever.inspect(project);
  if (!status.ok) return [];
  const { readFileSync } = await import("fs");
  const { parseSearchDocumentsJsonl } = await import(
    "@/lib/search/buildSearchDocuments"
  );
  const docs = [
    ...parseSearchDocumentsJsonl(readFileSync(status.docs_path, "utf8")).values(),
  ];
  return [...new Set(docs.map((d) => d.knowledge_unit_type))].sort();
}
