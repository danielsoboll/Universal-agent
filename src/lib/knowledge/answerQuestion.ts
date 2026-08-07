import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import { AI_CONFIG } from "@/lib/ai/config";
import { AIProviderError } from "@/lib/ai/errors";
import { fileProjectRepository } from "@/lib/localAuth/projectRepository";
import { fileHistoryRepository } from "@/lib/localAuth/historyRepository";
import type { LocalProject } from "@/lib/localAuth/types";
import {
  KnowledgeRetriever,
  type KnowledgeHit,
} from "@/lib/knowledge/knowledgeRetriever";
import { resolveAskLocalProject } from "@/lib/knowledge/resolveAskProject";
import {
  EMPTY_COMPACT_TECHNICAL_DETAILS,
  EMPTY_PROCESS_ANSWER,
  EMPTY_TECHNICAL_ANSWER,
  EMPTY_TECHNICAL_DETAILS,
  llmAnswerSchema,
  type CompactTechnicalDetails,
  type ProcessAnswer,
  type TechnicalAnswer,
  type TechnicalDetails,
} from "@/lib/knowledge/answerSchema";
import {
  buildAnswerContract,
  enrichTechnicalAnswerFromHits,
  ANSWER_CONTRACT_NO_PROCESS_MSG,
} from "@/lib/knowledge/answerContract";
import { buildEvidenceContext } from "@/lib/knowledge/evidenceContext";
import { classifyQuestionIntent } from "@/lib/knowledge/questionIntent";
import {
  buildCompactTechnicalDetails,
  buildTechnicalDetailsFromHits,
  expandRelatedHits,
  mergeTechnicalDetails,
} from "@/lib/knowledge/buildTechnicalDetails";
import type { QueryPlan, SearchMode } from "@/lib/knowledge/queryPlanSchema";
import { planQuery } from "@/lib/knowledge/queryPlanner";
import { runDeepSearch } from "@/lib/knowledge/deepSearch/runDeepSearch";
import {
  listAvailableKnowledgeUnitTypes,
} from "@/lib/knowledge/executeQueryPlan";
import { executePlannedRagRetrieval } from "@/lib/knowledge/executePlannedRag";
import { executeFullAnalysisRetrieval } from "@/lib/knowledge/executeFullAnalysis";
import { FULL_ANALYSIS_SYNTHESIS_ADDENDUM } from "@/lib/knowledge/fullAnalysisPrompt";
import {
  buildFullAnalysisReport,
  type FullAnalysisReport,
} from "@/lib/knowledge/fullAnalysisReport";
import {
  extractQueryEntities,
  groundQueryEntities,
  similarNeighborEntities,
  technicalAnchorFailClosedMessage,
  type EntityGroundingResult,
  type GroundingReport,
} from "@/lib/knowledge/entityGrounding";
import {
  assessRelevanceGate,
  hitsByIds,
  type RelevanceGateResult,
} from "@/lib/knowledge/relevanceGate";
import { resolveProjectCapabilities } from "@/lib/domain/capabilities";
import type { DomainProfileId } from "@/lib/domain/types";
import {
  decideSearchBudgetAfterLocalExact,
  emptySearchBudgetDiagnostics,
  estimateEmbeddingTokens,
  finalizeSearchBudgetAfterRetrieval,
  namedEntityTechnicalAnchors,
  prioritizeCommunicationHits,
  type SearchBudgetDiagnostics,
  type SearchBudgetGateDecision,
} from "@/lib/knowledge/searchBudget";

function resolveRequestedSearchMode(
  mode: SearchMode | undefined,
): SearchMode {
  if (mode === "planned_rag") return "planned_rag";
  if (mode === "full_analysis") return "full_analysis";
  if (mode === "deep_search") return "deep_search";
  return "direct_rag";
}

export type AnswerQuestionResult = {
  status: "ok" | "insufficient" | "error";
  question: string;
  /** Flat convenience field = process_answer.direct_answer */
  direct_answer: string;
  reasoning: string;
  technical_objects: string[];
  uncertainties: string[];
  process_answer: ProcessAnswer;
  /** Compact technical answer with evidence levels (Einstiegspunkt…offen). */
  technical_answer: TechnicalAnswer;
  technical_details: TechnicalDetails;
  /** Compact, max-5-section technical explanation (Quelle/Auslöser/Systemaktion/Beleg/Unsicherheit). */
  compact_technical_details: CompactTechnicalDetails;
  /** Synthesis intent (does not alter Direct RAG retrieval). */
  question_intent: string | null;
  /** Diagnostics: evidence-context truncation / diversification. */
  evidence_context_report: {
    input_hit_count: number;
    detailed_count: number;
    compact_count: number;
    omitted_count: number;
    previously_weak_fields_now_included: string[];
    notes: string[];
  } | null;
  /** Deterministic entity-grounding check, computed before answer synthesis. */
  entity_grounding: EntityGroundingResult[];
  /** Deterministic relevance gate — blocks synthesis when concepts lack evidence. */
  relevance_gate: RelevanceGateResult | null;
  sources: KnowledgeHit[];
  model: string;
  token_usage: { input: number; output: number; embedding: number };
  estimated_cost: number;
  retrieval_summary: string;
  retrieval_mode: string;
  searched_document_count: number;
  top_score: number | null;
  index_path: string;
  vector_search_active: boolean;
  warnings: string[];
  message?: string;
  /** User-selected search mode (possibly after fallback). */
  search_mode: SearchMode;
  /** Mode originally requested by the client. */
  requested_search_mode: SearchMode;
  query_plan: QueryPlan | null;
  subquery_count: number;
  planner_fallback: boolean;
  duration_ms: number;
  /** Active Domain Profile id for this answer. */
  domain_profile_id: DomainProfileId;
  /** Composed prompt key used for synthesis (and planner when planned_rag). */
  prompt_key: string;
  prompt_version: string;
  search_profile_id: string;
  workflow_template_id: string | null;
  /** Ask page is not a multi-turn chat; always false. */
  conversation_mode: false;
  /** planned_rag / full_analysis — fresh per question; null for direct_rag. */
  planned_run_id: string | null;
  /** planned_rag / full_analysis topic-gate summary; null for direct_rag. */
  topic_gate: {
    excluded: Array<{
      source_key: string;
      status: string;
      reason: string;
    }>;
    statuses: Array<{
      source_key: string;
      topic_status: string;
      reason: string;
    }>;
  } | null;
  /** full_analysis only — Markdown + Word download payload. */
  full_analysis_report: FullAnalysisReport | null;
  /** SEARCH_BUDGET_GATE diagnostics (stage, cache, OpenAI calls). */
  search_budget: SearchBudgetDiagnostics | null;
};

function emptyResult(
  question: string,
  message: string,
  extras?: Partial<AnswerQuestionResult>,
): AnswerQuestionResult {
  return {
    status: "error",
    question,
    direct_answer: "",
    reasoning: "",
    technical_objects: [],
    uncertainties: [],
    process_answer: { ...EMPTY_PROCESS_ANSWER },
    technical_answer: { ...EMPTY_TECHNICAL_ANSWER },
    technical_details: { ...EMPTY_TECHNICAL_DETAILS },
    compact_technical_details: { ...EMPTY_COMPACT_TECHNICAL_DETAILS },
    question_intent: null,
    evidence_context_report: null,
    entity_grounding: [],
    relevance_gate: null,
    sources: [],
    model: AI_CONFIG.chatModel,
    token_usage: { input: 0, output: 0, embedding: 0 },
    estimated_cost: 0,
    retrieval_summary: "",
    retrieval_mode: "none",
    searched_document_count: 0,
    top_score: null,
    index_path: "",
    vector_search_active: false,
    warnings: [],
    message,
    search_mode: "direct_rag",
    requested_search_mode: "direct_rag",
    query_plan: null,
    subquery_count: 0,
    planner_fallback: false,
    duration_ms: 0,
    domain_profile_id: "generic_documents",
    prompt_key: "",
    prompt_version: "",
    search_profile_id: "",
    workflow_template_id: null,
    conversation_mode: false,
    planned_run_id: null,
    topic_gate: null,
    full_analysis_report: null,
    search_budget: null,
    ...extras,
  };
}

function estimateCost(input: number, output: number, embedding: number): number {
  const chat = AI_CONFIG.pricingUsdPer1M[AI_CONFIG.chatModel] ?? {
    input: 0.4,
    output: 1.6,
  };
  const emb = AI_CONFIG.pricingUsdPer1M[AI_CONFIG.embeddingModel] ?? {
    input: 0.02,
    output: 0,
  };
  return Number(
    (
      (input / 1_000_000) * chat.input +
      (output / 1_000_000) * chat.output +
      (embedding / 1_000_000) * emb.input
    ).toFixed(6),
  );
}

function retrievalModeLabel(vectorActive: boolean, hasEmbeddings: boolean): string {
  if (vectorActive) return "hybrid (exact + fulltext + vector)";
  if (hasEmbeddings) return "lexical (exact + fulltext; vector skipped)";
  return "lexical (exact + fulltext)";
}

const ANSWER_SCHEMA_HINT = `
Ausgabeformat: strukturiertes JSON gemäß Schema
(process_answer mit statements/levels, technical_answer, technical_details,
insufficient_evidence, source_ranks_used).
confirmed nur mit source_ranks; inferred sprachlich markieren; possible nur offen.
`;

/**
 * Shared ask service for CLI and web UI.
 */
export async function answerQuestion(params: {
  projectId: string;
  userId?: string;
  question: string;
  limit?: number;
  project?: LocalProject;
  /** Manually selected search mode. Default: direct_rag */
  searchMode?: SearchMode;
}): Promise<AnswerQuestionResult> {
  const started = Date.now();
  const requestedMode: SearchMode = resolveRequestedSearchMode(
    params.searchMode,
  );
  let searchMode: SearchMode = requestedMode;
  let queryPlan: QueryPlan | null = null;
  let subqueryCount = 0;
  let plannerFallback = false;
  let plannerTokens = { input: 0, output: 0 };
  const warnings: string[] = [];

  const question = params.question.trim();
  if (!question) {
    return emptyResult(question, "Bitte eine Frage eingeben.", {
      requested_search_mode: requestedMode,
      search_mode: searchMode,
      duration_ms: Date.now() - started,
    });
  }

  let project = params.project ?? null;
  if (!project) {
    project = (await fileProjectRepository.getById(params.projectId)) ?? null;
  }
  if (!project) {
    const resolved = await resolveAskLocalProject(params.projectId);
    if (!resolved.ok) {
      return emptyResult(question, resolved.message, {
        requested_search_mode: requestedMode,
        search_mode: searchMode,
        duration_ms: Date.now() - started,
      });
    }
    project = resolved.project;
  }

  const inspected = KnowledgeRetriever.inspect(project);
  if (!inspected.ok) {
    console.error(
      "[answerQuestion] index validation failed:",
      inspected.message,
      inspected.data_root,
      inspected.docs_path,
    );
    return emptyResult(question, inspected.message, {
      index_path: "",
      searched_document_count: inspected.document_count,
      requested_search_mode: requestedMode,
      search_mode: searchMode,
      duration_ms: Date.now() - started,
    });
  }

  const capabilities = resolveProjectCapabilities(project);
  const domainMeta = {
    domain_profile_id: capabilities.domainProfileId,
    prompt_key: capabilities.answerPrompt.key,
    prompt_version: capabilities.answerPrompt.version,
    search_profile_id: capabilities.searchProfile.id,
    workflow_template_id: capabilities.workflowTemplateId,
  };

  type RetrievalBundle = {
    hits: KnowledgeHit[];
    document_count: number;
    vector_search_active: boolean;
    index_path: string;
    query_embedding_tokens: number;
    query_embedding_cost: number;
    warnings: string[];
  };

  let retrieval: RetrievalBundle;
  let searchBudget: SearchBudgetGateDecision | null = null;
  let openaiCalls = 0;
  let estimatedInputTokens = 0;
  let plannedRunId: string | null = null;
  let topicGate: AnswerQuestionResult["topic_gate"] = null;

  // --- KI-Tiefensuche: Query Understanding + Multi-Source (nicht direct_rag) ---
  if (searchMode === "deep_search") {
    try {
      const deep = await runDeepSearch({
        projectId: project.id,
        project,
        question,
        started,
        domainMeta: {
          domain_profile_id: domainMeta.domain_profile_id,
          prompt_key: domainMeta.prompt_key,
          prompt_version: domainMeta.prompt_version,
          search_profile_id: domainMeta.search_profile_id,
          workflow_template_id: domainMeta.workflow_template_id,
        },
      });
      if (params.userId) {
        try {
          await fileHistoryRepository.add({
            user_id: params.userId,
            project_id: project.id,
            question,
            answer: deep.answer.direct_answer,
            retrieval_summary: deep.answer.retrieval_summary,
            source_refs: deep.answer.sources.map((s) => ({
              rank: s.rank,
              source_key: s.source_key,
              title: s.title,
              knowledge_unit_type: s.knowledge_unit_type,
              score: s.combined_score,
            })),
            model: deep.answer.model,
            token_usage: deep.answer.token_usage,
            estimated_cost: deep.answer.estimated_cost,
          });
        } catch (histErr) {
          deep.answer.warnings = [
            ...deep.answer.warnings,
            `Verlauf konnte nicht gespeichert werden: ${
              histErr instanceof Error ? histErr.message : "unbekannt"
            }`,
          ];
        }
      }
      console.info(
        "[answerQuestion:deep_search]",
        JSON.stringify({
          intent: deep.query_understanding.intent,
          preferred_plan: deep.query_understanding.preferred_search_plan,
          technical_tokens: deep.query_understanding.technical_tokens,
          log_dir: deep.log_dir,
          runtime_ms: deep.metrics.runtime_ms,
          evidence_count: deep.metrics.evidence_count,
          cost: deep.metrics.cost,
        }),
      );
      return deep.answer;
    } catch (error) {
      console.error("[answerQuestion] deep_search failed:", error);
      return emptyResult(
        question,
        error instanceof Error ? error.message : "KI-Tiefensuche fehlgeschlagen.",
        {
          index_path: project.active_index_path,
          searched_document_count: inspected.document_count,
          requested_search_mode: requestedMode,
          search_mode: "deep_search",
          duration_ms: Date.now() - started,
        },
      );
    }
  }

  try {
    if (searchMode === "full_analysis") {
      const availableTypes = await listAvailableKnowledgeUnitTypes(project);
      const planned = await planQuery({
        question,
        availableKnowledgeUnitTypes:
          availableTypes.length > 0
            ? availableTypes
            : [...capabilities.knowledgeUnitTypes],
        domainProfile: capabilities.domainProfile,
        plannerPrompt: capabilities.plannerPrompt,
      });
      plannerTokens = planned.token_usage;
      domainMeta.prompt_key = planned.prompt_key ?? capabilities.plannerPrompt.key;
      domainMeta.prompt_version =
        planned.prompt_version ?? capabilities.plannerPrompt.version;

      if (!planned.ok) {
        plannerFallback = true;
        warnings.push(
          "Vollanalyse-Suchplanung fehlgeschlagen; breite Direktsuche verwendet.",
        );
        console.error(
          "[answerQuestion] full_analysis planner failed:",
          planned.message,
        );
        domainMeta.prompt_key = capabilities.answerPrompt.key;
        domainMeta.prompt_version = capabilities.answerPrompt.version;
        const broad = await KnowledgeRetriever.search({
          project,
          query: question,
          limit: params.limit ?? 40,
          searchProfile: capabilities.searchProfile,
          enableRelationExpansion: true,
        });
        retrieval = {
          hits: broad.hits,
          document_count: broad.document_count,
          vector_search_active: broad.vector_search_active,
          index_path: broad.index_path,
          query_embedding_tokens: broad.query_embedding_tokens,
          query_embedding_cost: broad.query_embedding_cost,
          warnings: broad.warnings,
        };
        subqueryCount = 1;
        plannedRunId = null;
        topicGate = null;
      } else {
        queryPlan = planned.plan;
        subqueryCount = planned.plan.subqueries.length;
        if (planned.repaired) {
          warnings.push("Suchplan nach einmaliger Repair-Anfrage validiert.");
        }
        const executed = await executeFullAnalysisRetrieval({
          project,
          originalQuestion: question,
          plan: planned.plan,
          domainProfile: capabilities.domainProfile,
          searchProfile: capabilities.searchProfile,
          limitPerSubquery: 16,
          finalLimit: params.limit ?? 40,
        });
        queryPlan = {
          ...planned.plan,
          subqueries: executed.refined_plan_subqueries,
        };
        subqueryCount = executed.subquery_count;
        plannedRunId = executed.run_id;
        topicGate = {
          excluded: executed.diagnostics.topic_excluded.map((e) => ({
            source_key: e.source_key,
            status: e.status,
            reason: e.reason,
          })),
          statuses: executed.diagnostics.topic_statuses.map((s) => ({
            source_key: s.source_key,
            topic_status: s.topic_status,
            reason: s.reason,
          })),
        };
        warnings.push(...executed.warnings);
        console.info(
          "[full_analysis:synthesis_context]",
          JSON.stringify({
            run_id: executed.run_id,
            original_question: question,
            evidence_ids: executed.run_debug.final_evidence_ids,
            synthesis_context_ids: executed.run_debug.synthesis_context_ids,
            excluded: executed.run_debug.excluded,
          }),
        );
        retrieval = {
          hits: executed.hits,
          document_count: executed.document_count,
          vector_search_active: executed.vector_search_active,
          index_path: executed.index_path,
          query_embedding_tokens: executed.query_embedding_tokens,
          query_embedding_cost: executed.query_embedding_cost,
          warnings: [],
        };
      }
    } else if (searchMode === "planned_rag") {
      const availableTypes = await listAvailableKnowledgeUnitTypes(project);
      // Isolated planner call — only current question; no prior plan/history.
      const planned = await planQuery({
        question,
        availableKnowledgeUnitTypes:
          availableTypes.length > 0
            ? availableTypes
            : [...capabilities.knowledgeUnitTypes],
        domainProfile: capabilities.domainProfile,
        plannerPrompt: capabilities.plannerPrompt,
      });
      plannerTokens = planned.token_usage;
      domainMeta.prompt_key = planned.prompt_key ?? capabilities.plannerPrompt.key;
      domainMeta.prompt_version =
        planned.prompt_version ?? capabilities.plannerPrompt.version;

      if (!planned.ok) {
        plannerFallback = true;
        searchMode = "direct_rag";
        warnings.push(
          "KI-Suchplanung fehlgeschlagen; direkte Suche verwendet.",
        );
        console.error("[answerQuestion] query planner failed:", planned.message);
        domainMeta.prompt_key = capabilities.answerPrompt.key;
        domainMeta.prompt_version = capabilities.answerPrompt.version;
      } else {
        queryPlan = planned.plan;
        subqueryCount = planned.plan.subqueries.length;
        if (planned.repaired) {
          warnings.push("Suchplan nach einmaliger Repair-Anfrage validiert.");
        }
        const executed = await executePlannedRagRetrieval({
          project,
          originalQuestion: question,
          plan: planned.plan,
          domainProfile: capabilities.domainProfile,
          searchProfile: capabilities.searchProfile,
          limitPerSubquery: 8,
          finalLimit: params.limit ?? 12,
        });
        // Persist refined subquery list on the plan for UI/diagnostics
        queryPlan = {
          ...planned.plan,
          subqueries: executed.refined_plan_subqueries,
        };
        subqueryCount = executed.subquery_count;
        plannedRunId = executed.run_id;
        topicGate = {
          excluded: executed.diagnostics.topic_excluded.map((e) => ({
            source_key: e.source_key,
            status: e.status,
            reason: e.reason,
          })),
          statuses: executed.diagnostics.topic_statuses.map((s) => ({
            source_key: s.source_key,
            topic_status: s.topic_status,
            reason: s.reason,
          })),
        };
        warnings.push(...executed.warnings);
        // Log synthesis context ids (evidence only from this run).
        console.info(
          "[planned_rag:synthesis_context]",
          JSON.stringify({
            run_id: executed.run_id,
            original_question: question,
            evidence_ids: executed.run_debug.final_evidence_ids,
            synthesis_context_ids: executed.run_debug.synthesis_context_ids,
            excluded: executed.run_debug.excluded,
          }),
        );
        retrieval = {
          hits: executed.hits,
          document_count: executed.document_count,
          vector_search_active: executed.vector_search_active,
          index_path: executed.index_path,
          query_embedding_tokens: executed.query_embedding_tokens,
          query_embedding_cost: executed.query_embedding_cost,
          warnings: [],
        };
      }
    }

    if (searchMode === "direct_rag") {
      // SEARCH_BUDGET_GATE Stage 0: LOCAL_EXACT (no vector / no embedding OpenAI)
      const local = await KnowledgeRetriever.search({
        project,
        query: question,
        limit: params.limit ?? 12,
        searchProfile: capabilities.searchProfile,
        enableVector: false,
      });
      searchBudget = decideSearchBudgetAfterLocalExact({
        question,
        searchMode,
        localHits: local.hits,
      });

      if (
        searchBudget.stage === "LOCAL_EXACT" &&
        searchBudget.coverage.sufficient
      ) {
        retrieval = {
          hits: searchBudget.hits,
          document_count: local.document_count,
          vector_search_active: false,
          index_path: local.index_path,
          query_embedding_tokens: 0,
          query_embedding_cost: 0,
          warnings: [
            ...local.warnings,
            `SEARCH_BUDGET=${searchBudget.stage}`,
            searchBudget.diagnostics.blocked_reason ?? "",
          ].filter(Boolean),
        };
        searchBudget.diagnostics.new_openai_calls = openaiCalls;
        searchBudget.diagnostics.estimated_input_tokens = estimatedInputTokens;
      } else {
        // Stage 1: EXISTING_RETRIEVAL — hybrid over existing indexes (may embed query)
        const full = await KnowledgeRetriever.search({
          project,
          query: question,
          limit: params.limit ?? 12,
          searchProfile: capabilities.searchProfile,
          enableVector: true,
        });
        if (full.query_embedding_tokens > 0) {
          openaiCalls += 1;
          estimatedInputTokens +=
            full.query_embedding_tokens || estimateEmbeddingTokens(question);
        }
        retrieval = {
          hits: prioritizeCommunicationHits(
            full.hits,
            namedEntityTechnicalAnchors(question),
          ),
          document_count: full.document_count,
          vector_search_active: full.vector_search_active,
          index_path: full.index_path,
          query_embedding_tokens: full.query_embedding_tokens,
          query_embedding_cost: full.query_embedding_cost,
          warnings: [
            ...full.warnings,
            `SEARCH_BUDGET=${searchBudget.stage}`,
            searchBudget.diagnostics.escalation_reason ?? "",
          ].filter(Boolean),
        };
        searchBudget.diagnostics.retrieval_hit_count = full.hits.length;
        searchBudget.diagnostics.new_openai_calls = openaiCalls;
        searchBudget.diagnostics.estimated_input_tokens = estimatedInputTokens;
      }
      subqueryCount = subqueryCount || 1;
      plannedRunId = null;
      topicGate = null;
    }
  } catch (error) {
    console.error("[answerQuestion] retrieval failed:", error);
    const msg = error instanceof Error ? error.message : "";
    const userMsg =
      /nicht lesbar|EACCES|ENOENT|JSON/i.test(msg)
        ? "Index nicht lesbar"
        : "Wissensbestand konnte nicht gelesen werden.";
    return emptyResult(question, userMsg, {
      index_path: project.active_index_path,
      searched_document_count: inspected.document_count,
      requested_search_mode: requestedMode,
      search_mode: searchMode,
      planner_fallback: plannerFallback,
      query_plan: queryPlan,
      subquery_count: subqueryCount,
      warnings,
      duration_ms: Date.now() - started,
    });
  }

  warnings.push(...retrieval!.warnings);

  const mode = retrievalModeLabel(
    retrieval!.vector_search_active,
    inspected.has_embeddings,
  );
  const topScore =
    retrieval!.hits.length > 0 ? retrieval!.hits[0]!.combined_score : null;

  // Deterministic entity grounding — runs before answer synthesis, independent
  // of the LLM. Generic across customers/materials/plants/etc.
  const queryEntities = extractQueryEntities(question, queryPlan);
  const groundingReport: GroundingReport = groundQueryEntities({
    queryEntities,
    hits: retrieval!.hits,
  });

  const relevanceGate = assessRelevanceGate({
    question,
    hits: retrieval!.hits,
    grounding: groundingReport,
    domainProfile: capabilities.domainProfile,
  });

  // Finalize SEARCH_BUDGET after retrieval + gate (no mass analysis).
  if (searchBudget) {
    searchBudget = finalizeSearchBudgetAfterRetrieval({
      question,
      searchMode,
      prior: searchBudget,
      retrievalHits: retrieval!.hits,
      relevanceSufficient:
        relevanceGate.answerability === "answerable" ||
        relevanceGate.answerability === "partially_answerable",
    });
    if (searchBudget.fail_closed) {
      retrieval = {
        ...retrieval!,
        hits: [],
      };
    } else if (searchBudget.hits.length > 0) {
      retrieval = {
        ...retrieval!,
        hits: searchBudget.hits,
      };
    }
    searchBudget.diagnostics.new_openai_calls = openaiCalls;
    searchBudget.diagnostics.estimated_input_tokens = estimatedInputTokens;
  } else if (searchMode === "full_analysis" || searchMode === "deep_search") {
    searchBudget = {
      stage: "DEEP_ANALYSIS",
      hits: retrieval!.hits,
      fail_closed: false,
      fail_closed_message: null,
      allow_vector_retrieval: true,
      allow_on_demand_analysis: true,
      on_demand_limit: 5,
      coverage: {
        sufficient: false,
        local_exact_hits: [],
        communication_hits: [],
        cache_hits: 0,
        missing_code_analysis: [],
        reason: "DEEP_ANALYSIS mode",
      },
      diagnostics: {
        ...emptySearchBudgetDiagnostics("DEEP_ANALYSIS"),
        escalation_reason:
          searchMode === "full_analysis"
            ? "Suchmodus Vollanalyse"
            : "Suchmodus KI-Tiefensuche",
        retrieval_hit_count: retrieval!.hits.length,
      },
    };
  }

  const budgetDiag =
    searchBudget?.diagnostics ?? emptySearchBudgetDiagnostics();

  const metaExtras = {
    search_mode: searchMode,
    requested_search_mode: requestedMode,
    query_plan: queryPlan,
    subquery_count: subqueryCount,
    planner_fallback: plannerFallback,
    duration_ms: Date.now() - started,
    warnings: [
      ...warnings,
      ...(searchBudget
        ? [
            `search_budget_stage=${searchBudget.stage}`,
            searchBudget.diagnostics.escalation_reason
              ? `search_budget_escalation=${searchBudget.diagnostics.escalation_reason}`
              : "",
            searchBudget.diagnostics.blocked_reason
              ? `search_budget_blocked=${searchBudget.diagnostics.blocked_reason}`
              : "",
          ].filter(Boolean)
        : []),
    ],
    ...domainMeta,
    prompt_key:
      (searchMode === "planned_rag" || searchMode === "full_analysis") &&
      queryPlan
        ? capabilities.plannerPrompt.key
        : capabilities.answerPrompt.key,
    prompt_version:
      (searchMode === "planned_rag" || searchMode === "full_analysis") &&
      queryPlan
        ? capabilities.plannerPrompt.version
        : capabilities.answerPrompt.version,
    conversation_mode: false as const,
    planned_run_id: plannedRunId,
    topic_gate: topicGate,
    full_analysis_report: null as FullAnalysisReport | null,
    search_budget: budgetDiag,
  };

  const questionIntent = classifyQuestionIntent(question);

  if (retrieval!.hits.length === 0) {
    const failMsg =
      searchBudget?.fail_closed_message ??
      "Im aktuell indexierten Wissensbestand nicht belastbar beantwortbar.";
    const pa: ProcessAnswer = {
      ...EMPTY_PROCESS_ANSWER,
      direct_answer: failMsg,
      open_validation_questions: [
        searchBudget?.fail_closed
          ? "Keine belastbare technische Verbindung zum genannten Anker."
          : "Keine passenden SearchDocuments gefunden.",
      ],
      open: [
        {
          text: searchBudget?.fail_closed
            ? "Keine belastbare technische Verbindung zum genannten Anker."
            : "Keine passenden SearchDocuments gefunden.",
          level: "not_supported",
          source_ranks: [],
          source_ids: [],
        },
      ],
      has_safe_process_claim: false,
      no_process_claim_message: ANSWER_CONTRACT_NO_PROCESS_MSG,
    };
    return {
      status: "insufficient",
      question,
      direct_answer: pa.direct_answer,
      reasoning: searchBudget?.fail_closed
        ? "SEARCH_BUDGET fail-closed: kein technischer Anker-Treffer."
        : "Die Suche lieferte keine Treffer.",
      technical_objects: [],
      uncertainties: pa.open_validation_questions,
      process_answer: pa,
      technical_answer: { ...EMPTY_TECHNICAL_ANSWER },
      technical_details: {
        ...EMPTY_TECHNICAL_DETAILS,
        retrieval_mode: mode,
      },
      compact_technical_details: { ...EMPTY_COMPACT_TECHNICAL_DETAILS },
      question_intent: questionIntent.intent,
      evidence_context_report: null,
      entity_grounding: groundingReport.results,
      relevance_gate: relevanceGate,
      sources: [],
      model: AI_CONFIG.chatModel,
      token_usage: {
        input: plannerTokens.input,
        output: plannerTokens.output,
        embedding: retrieval!.query_embedding_tokens,
      },
      estimated_cost:
        estimateCost(plannerTokens.input, plannerTokens.output, 0) +
        retrieval!.query_embedding_cost,
      retrieval_summary: searchBudget?.fail_closed
        ? `0 Treffer (fail-closed, stage=${searchBudget.stage})`
        : `0/${retrieval!.document_count} Treffer`,
      retrieval_mode: mode,
      searched_document_count: retrieval!.document_count,
      top_score: null,
      index_path: project.active_index_path,
      vector_search_active: retrieval!.vector_search_active,
      ...metaExtras,
      duration_ms: Date.now() - started,
    };
  }

  // Relevance gate: do not invent answers from only loosely related hits.
  if (relevanceGate.answerability === "insufficient") {
    const similarHits = hitsByIds(
      retrieval!.hits,
      relevanceGate.similar_but_insufficient_source_ids,
    ).slice(0, 5);
    const failClosedDirect = groundingReport.has_ungrounded_technical_anchor
      ? technicalAnchorFailClosedMessage(
          groundingReport.ungrounded_technical_anchors,
        )
      : "Im aktuell indexierten Wissensbestand wurde keine belastbare Quelle gefunden, die diese Frage beantwortet.";
    const openNotes = [
      relevanceGate.reason,
      groundingReport.has_ungrounded_technical_anchor
        ? "Verwandte Tabellen/Felder ohne Anker-Beleg werden nicht ausgegeben."
        : "",
      relevanceGate.missing_concepts.length
        ? `Fehlende zentrale Belege: ${relevanceGate.missing_concepts.join(", ")}`
        : "",
      relevanceGate.query_concepts.length
        ? `Gesuchte Konzepte: ${relevanceGate.query_concepts.join(", ")}`
        : "",
      !groundingReport.has_ungrounded_technical_anchor && similarHits.length
        ? "Es liegen nur ähnliche, aber nicht ausreichend passende Treffer vor (siehe Quellen)."
        : "",
    ].filter(Boolean);
    const pa: ProcessAnswer = {
      ...EMPTY_PROCESS_ANSWER,
      direct_answer: failClosedDirect,
      open_validation_questions: openNotes,
      open: openNotes.map((text) => ({
        text,
        level: "not_supported" as const,
        source_ranks: [],
        source_ids: [],
      })),
      has_safe_process_claim: false,
      no_process_claim_message: ANSWER_CONTRACT_NO_PROCESS_MSG,
    };
    return {
      status: "insufficient",
      question,
      direct_answer: pa.direct_answer,
      reasoning: relevanceGate.reason,
      technical_objects: [],
      uncertainties: pa.open_validation_questions,
      process_answer: pa,
      technical_answer: { ...EMPTY_TECHNICAL_ANSWER },
      technical_details: {
        ...EMPTY_TECHNICAL_DETAILS,
        retrieval_mode: mode,
        evidence: groundingReport.has_ungrounded_technical_anchor
          ? []
          : similarHits.map(
              (h) =>
                `Ähnlicher, nicht ausreichender Treffer: ${h.title || h.source_key}`,
            ),
      },
      compact_technical_details: groundingReport.has_ungrounded_technical_anchor
        ? { ...EMPTY_COMPACT_TECHNICAL_DETAILS }
        : {
            ...EMPTY_COMPACT_TECHNICAL_DETAILS,
            unsicherheit: pa.open_validation_questions,
          },
      question_intent: questionIntent.intent,
      evidence_context_report: null,
      entity_grounding: groundingReport.results,
      relevance_gate: relevanceGate,
      sources: groundingReport.has_ungrounded_technical_anchor ? [] : similarHits,
      model: AI_CONFIG.chatModel,
      token_usage: {
        input: plannerTokens.input,
        output: plannerTokens.output,
        embedding: retrieval!.query_embedding_tokens,
      },
      estimated_cost:
        estimateCost(plannerTokens.input, plannerTokens.output, 0) +
        retrieval!.query_embedding_cost,
      retrieval_summary: `${retrieval!.hits.length}/${retrieval!.document_count} Treffer (nicht ausreichend relevant)`,
      retrieval_mode: mode,
      searched_document_count: retrieval!.document_count,
      top_score: topScore,
      index_path: project.active_index_path,
      vector_search_active: retrieval!.vector_search_active,
      ...metaExtras,
      duration_ms: Date.now() - started,
    };
  }

  const synthesisHits =
    searchMode === "full_analysis"
      ? retrieval!.hits
      : relevanceGate.supporting_source_ids.length > 0
        ? hitsByIds(retrieval!.hits, relevanceGate.supporting_source_ids)
        : retrieval!.hits;

  if (!process.env.OPENAI_API_KEY?.trim()) {
    const tech = buildTechnicalDetailsFromHits(synthesisHits, mode);
    return {
      status: "error",
      question,
      direct_answer: "",
      reasoning: "",
      technical_objects: tech.called_objects,
      uncertainties: [],
      process_answer: { ...EMPTY_PROCESS_ANSWER },
      technical_answer: enrichTechnicalAnswerFromHits(
        { ...EMPTY_TECHNICAL_ANSWER },
        synthesisHits,
      ),
      technical_details: tech,
      compact_technical_details: buildCompactTechnicalDetails({
        hits: synthesisHits,
        groundingResults: groundingReport.results,
      }),
      question_intent: questionIntent.intent,
      evidence_context_report: null,
      entity_grounding: groundingReport.results,
      relevance_gate: relevanceGate,
      sources: synthesisHits,
      model: AI_CONFIG.chatModel,
      token_usage: {
        input: plannerTokens.input,
        output: plannerTokens.output,
        embedding: retrieval!.query_embedding_tokens,
      },
      estimated_cost:
        estimateCost(plannerTokens.input, plannerTokens.output, 0) +
        retrieval!.query_embedding_cost,
      retrieval_summary: `${retrieval!.hits.length}/${retrieval!.document_count} Treffer (ohne Antwortgenerierung)`,
      retrieval_mode: mode,
      searched_document_count: retrieval!.document_count,
      top_score: topScore,
      index_path: project.active_index_path,
      vector_search_active: retrieval!.vector_search_active,
      message:
        "OPENAI_API_KEY fehlt. Retrieval hat Treffer geliefert, aber keine Antwort kann erzeugt werden.",
      ...metaExtras,
      duration_ms: Date.now() - started,
    };
  }

  try {
    const client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      timeout:
        searchMode === "full_analysis"
          ? AI_CONFIG.analysisTimeoutMs
          : AI_CONFIG.timeoutMs,
      maxRetries: AI_CONFIG.maxRetries,
    });
    const planBlock =
      (searchMode === "planned_rag" || searchMode === "full_analysis") &&
      queryPlan
        ? [
            "",
            searchMode === "full_analysis"
              ? "Suchmodus: full_analysis (Vollanalyse)"
              : "Suchmodus: planned_rag (KI-Tiefensuche)",
            `Intent: ${queryPlan.intent}`,
            `Planner-Confidence: ${queryPlan.planner_confidence}`,
            queryPlan.ambiguities.length
              ? `Ambiguitäten: ${queryPlan.ambiguities.join(" | ")}`
              : "",
            `Subqueries: ${queryPlan.subqueries
              .map((s) => `${s.id}: ${s.query}`)
              .join(" || ")}`,
            `required_evidence: ${queryPlan.required_evidence.join(", ") || "—"}`,
          ]
            .filter(Boolean)
            .join("\n")
        : `\nSuchmodus: ${searchMode}`;

    const groundingBlock = [
      "",
      "Entity-Grounding (deterministisch, bindend — siehe Systemregeln):",
      queryEntities.length === 0
        ? "Keine benannte Entität in der Frage erkannt."
        : groundingReport.results
            .map(
              (r) =>
                `- "${r.query_entity}" [${r.entity_type}]: ${r.grounding_status}` +
                (r.matched_source_entities.length
                  ? ` · source_entities: ${r.matched_source_entities.join(", ")}`
                  : "") +
                ` · Begründung: ${r.reason}`,
            )
            .join("\n"),
      groundingReport.grounded_entity_names.length
        ? `grounded_entities: ${groundingReport.grounded_entity_names.join(", ")}`
        : "grounded_entities: —",
      groundingReport.contradicted_entity_names.length
        ? `contradicted_entities/not_found: ${groundingReport.contradicted_entity_names.join(", ")}`
        : "contradicted_entities/not_found: —",
    ].join("\n");

    const relevanceBlock = [
      "",
      "Relevance-Gate (deterministisch, bindend):",
      `answerability: ${relevanceGate.answerability}`,
      `query_concepts: ${relevanceGate.query_concepts.join(", ") || "—"}`,
      `matched_concepts: ${relevanceGate.matched_concepts.join(", ") || "—"}`,
      `missing_concepts: ${relevanceGate.missing_concepts.join(", ") || "—"}`,
      `reason: ${relevanceGate.reason}`,
      relevanceGate.answerability === "partially_answerable"
        ? "Nur den belegten Teil beantworten; fehlende Konzepte ausdrücklich offen lassen. Keine Ersatzobjekte."
        : "Nur aus den bereitgestellten (bereits gefilterten) unterstützenden Quellen antworten.",
    ].join("\n");

    const topicGateBlock =
      (searchMode === "planned_rag" || searchMode === "full_analysis") &&
      topicGate
        ? [
            "",
            `Topic-Gate (${searchMode}, run_id=${plannedRunId ?? "—"}):`,
            "Nur confirmed-Quellen als Fakten; possible nur als markierte Unsicherheit; not_relevant wurde entfernt.",
            topicGate.statuses.length
              ? topicGate.statuses
                  .map(
                    (s) =>
                      `- ${s.source_key}: ${s.topic_status} — ${s.reason}`,
                  )
                  .join("\n")
              : "keine Status-Einträge",
            topicGate.excluded.length
              ? `ausgeschlossen: ${topicGate.excluded
                  .map((e) => `${e.source_key} (${e.reason})`)
                  .join(" | ")}`
              : "ausgeschlossen: —",
          ].join("\n")
        : "";

    const evidenceContext = buildEvidenceContext({
      hits: synthesisHits,
      intent: questionIntent,
      groundingResults: groundingReport.results,
      question,
      coverage: searchMode === "full_analysis" ? "exhaustive" : "normal",
    });

    const intentBlock = [
      "",
      `Question-Intent (nur Synthese-Gewichtung, ändert Direct-RAG-Ranking nicht): ${questionIntent.intent}`,
      `preferences: process=${questionIntent.preferences.prefer_process_weight} tech=${questionIntent.preferences.prefer_tech_weight} relations=${questionIntent.preferences.prefer_relations} comparison_both_sides=${questionIntent.preferences.require_both_comparison_sides}`,
    ].join("\n");

    const userPrompt = [
      `Frage: ${question}`,
      planBlock,
      intentBlock,
      groundingBlock,
      relevanceBlock,
      topicGateBlock,
      "",
      evidenceContext.prompt_text,
    ].join("\n");

    const completion = await client.chat.completions.parse({
      model: AI_CONFIG.chatModel,
      // Isolated single-turn ask — never append prior Q&A / history / cache.
      messages: [
        {
          role: "system",
          content: [
            capabilities.answerPrompt.text,
            ANSWER_SCHEMA_HINT,
            searchMode === "full_analysis"
              ? FULL_ANALYSIS_SYNTHESIS_ADDENDUM
              : "",
            `Domain Profile: ${capabilities.domainProfileId}@${capabilities.domainProfile.version}`,
            `Suchmodus: ${searchMode}`,
            "conversation_mode=false — beantworte nur die aktuelle Frage aus den aktuellen Quellen.",
          ]
            .filter(Boolean)
            .join("\n\n"),
        },
        { role: "user", content: userPrompt },
      ],
      response_format: zodResponseFormat(llmAnswerSchema, "rag_structured_answer"),
      temperature: 0,
    });

    const parsed = completion.choices[0]?.message?.parsed;
    if (!parsed) {
      throw new AIProviderError({
        message: "Strukturierte Antwort fehlt.",
        category: "provider",
        retryable: true,
      });
    }

    const validated = llmAnswerSchema.parse(parsed);

    const input = (completion.usage?.prompt_tokens ?? 0) + plannerTokens.input;
    const output =
      (completion.usage?.completion_tokens ?? 0) + plannerTokens.output;
    const embedding = retrieval!.query_embedding_tokens;
    openaiCalls += 1;
    estimatedInputTokens += input;
    if (searchBudget) {
      searchBudget.diagnostics.new_openai_calls = openaiCalls;
      searchBudget.diagnostics.estimated_input_tokens = estimatedInputTokens;
      searchBudget.diagnostics.notes.push(
        `Synthese aus Bestand (stage=${searchBudget.stage}); on_demand_executed=${searchBudget.diagnostics.on_demand_executed}.`,
      );
      // Keep metaExtras.search_budget in sync
      (metaExtras as { search_budget: SearchBudgetDiagnostics }).search_budget =
        searchBudget.diagnostics;
    }

    // Deterministic gate — never trust the LLM's insufficient_evidence flag
    // alone for named-entity transfer; grounding was computed before synthesis.
    const ungroundedNamed = groundingReport.results.filter(
      (r) =>
        r.entity_type !== "identifier" &&
        r.entity_type !== "unknown" &&
        (r.grounding_status === "contradicted" ||
          r.grounding_status === "not_found"),
    );
    const hasUngroundedNamedEntity = ungroundedNamed.length > 0;
    const gateAllowsAnswer =
      relevanceGate.answerability === "answerable" ||
      relevanceGate.answerability === "partially_answerable";

    // "Welche Kunden …?" without any concrete customer/partner ids in supporting
    // evidence must not become a positive process answer (DESADV-style false hits).
    const asksWhichCustomers = /für welche kunden|welche kunden\b/i.test(
      question,
    );
    const customerIdInEvidence = synthesisHits.some((h) =>
      (h.hardcoded_values ?? []).some((v) =>
        /'\d{6,}'|\b\d{6,}\b/.test(v),
      ) ||
      (h.entities ?? []).some((e) =>
        /customer|kunde|lifnr|kunnr|partner/i.test(e.kind) &&
        /\d{4,}/.test(e.name),
      ),
    );
    const customerQuestionWithoutIds =
      asksWhichCustomers && !customerIdInEvidence;

    const insufficient =
      hasUngroundedNamedEntity ||
      customerQuestionWithoutIds ||
      (validated.insufficient_evidence && !gateAllowsAnswer) ||
      (!validated.process_answer.summary.trim() &&
        validated.process_answer.statements.length === 0 &&
        !gateAllowsAnswer);

    const insufficientMessage = hasUngroundedNamedEntity
      ? `Für „${ungroundedNamed.map((r) => r.query_entity).join(", ")}“ liegt im aktuell indexierten Wissensbestand keine belastbare, entitätsspezifische Regel vor.`
      : customerQuestionWithoutIds
        ? "Im aktuell indexierten Wissensbestand sind keine konkreten kundenspezifischen Anpassungen (mit belegten Kunden-/Partnernummern) für diese Frage nachweisbar."
        : "Im aktuell indexierten Wissensbestand nicht belastbar beantwortbar.";

    const contract = buildAnswerContract({
      llm: validated,
      hits: synthesisHits,
      intent: questionIntent,
      forceInsufficient: insufficient,
      insufficientMessage,
    });

    let process_answer = contract.process_answer;
    if (insufficient && hasUngroundedNamedEntity) {
      const neighbors = similarNeighborEntities(groundingReport);
      const neighborNote =
        neighbors.length > 0
          ? `Ähnliche gefundene Regel (nicht anwendbar): Für ${neighbors.join(", ")} liegt eine belegte Regel vor — diese gilt nicht automatisch für „${ungroundedNamed.map((r) => r.query_entity).join(", ")}“ und wurde nicht übertragen.`
          : "";
      process_answer = {
        ...process_answer,
        business_interpretation: neighborNote,
        inferred: neighborNote
          ? [
              {
                text: neighborNote,
                level: "inferred",
                source_ranks: [],
                source_ids: [],
              },
            ]
          : [],
        open: [
          ...ungroundedNamed.map((r) => ({
            text: `Für „${r.query_entity}“ (${r.entity_type}): ${r.reason}`,
            level: "not_supported" as const,
            source_ranks: [],
            source_ids: [],
          })),
          ...process_answer.open,
        ],
        open_validation_questions: [
          ...ungroundedNamed.map(
            (r) => `Für „${r.query_entity}“ (${r.entity_type}): ${r.reason}`,
          ),
          ...process_answer.open_validation_questions,
        ],
      };
    } else if (
      !insufficient &&
      relevanceGate.answerability === "partially_answerable"
    ) {
      const extras = [
        relevanceGate.reason,
        ...relevanceGate.missing_concepts.map(
          (c) => `Nicht belegt / offen: ${c}`,
        ),
      ].filter(Boolean);
      process_answer = {
        ...process_answer,
        open: [
          ...process_answer.open,
          ...extras.map((text) => ({
            text,
            level: "possible" as const,
            source_ranks: [],
            source_ids: [],
          })),
        ],
        open_validation_questions: [
          ...process_answer.open_validation_questions,
          ...extras,
        ],
        direct_answer:
          process_answer.direct_answer.trim() ||
          `Nur teilweise belegbar. Belegt: ${relevanceGate.matched_concepts.join(", ") || "—"}. Nicht belegt: ${relevanceGate.missing_concepts.join(", ") || "—"}.`,
      };
    }

    const usedRanks = new Set(contract.source_ranks_used);
    let sources =
      usedRanks.size > 0
        ? synthesisHits.filter((h) => usedRanks.has(h.rank))
        : synthesisHits;
    if (
      sources.length === 0 &&
      relevanceGate.answerability === "partially_answerable"
    ) {
      sources = synthesisHits.slice(0, 8);
    }

    const primaryForTech =
      sources.length > 0 ? sources : synthesisHits.slice(0, 5);
    const techHits =
      insufficient && hasUngroundedNamedEntity
        ? []
        : expandRelatedHits(primaryForTech, synthesisHits);
    const techBase = buildTechnicalDetailsFromHits(
      techHits.length > 0 ? techHits : insufficient ? [] : primaryForTech,
      mode,
    );
    const technical_details = mergeTechnicalDetails(
      techBase,
      insufficient && hasUngroundedNamedEntity
        ? { conditions: [], changed_fields: [], additional_evidence_notes: [] }
        : validated.technical_details,
    );

    const neighborRanks = new Set(
      ungroundedNamed
        .filter((r) => r.grounding_status === "contradicted")
        .flatMap((r) => r.evidence_refs)
        .map((ref) => Number(ref.match(/^#(\d+)/)?.[1]))
        .filter((n): n is number => Number.isFinite(n)),
    );
    const neighborHits = retrieval!.hits.filter((h) => neighborRanks.has(h.rank));

    let technical_answer = enrichTechnicalAnswerFromHits(
      contract.technical_answer,
      insufficient && hasUngroundedNamedEntity
        ? neighborHits
        : techHits.length > 0
          ? techHits
          : primaryForTech,
    );
    if (insufficient && hasUngroundedNamedEntity) {
      technical_answer = {
        ...technical_answer,
        entry_point: technical_answer.entry_point.map((s) => ({
          ...s,
          text: `Ähnliche gefundene Regel (nicht angefragte Entität) — ${s.text}`,
          level: s.level === "confirmed" ? "inferred" : s.level,
        })),
      };
    }

    const compact_technical_details: CompactTechnicalDetails =
      insufficient && hasUngroundedNamedEntity
        ? (() => {
            const compact = buildCompactTechnicalDetails({
              hits: neighborHits,
              groundingResults: groundingReport.results,
            });
            return {
              ...compact,
              quelle: compact.quelle.map(
                (q) => `Ähnliche gefundene Regel (nicht angefragte Entität) — ${q}`,
              ),
            };
          })()
        : buildCompactTechnicalDetails({
            hits: techHits.length > 0 ? techHits : primaryForTech,
            groundingResults: groundingReport.results,
            extraAusloeser: insufficient ? [] : validated.technical_details.conditions,
            extraSystemaktion: insufficient ? [] : validated.technical_details.changed_fields,
          });

    const reasoningParts = [
      process_answer.confirmed.length
        ? `Sicher belegt: ${process_answer.confirmed.map((s) => s.text).join(" ")}`
        : "",
      process_answer.inferred.length
        ? `Abgeleitet: ${process_answer.inferred.map((s) => s.text).join(" ")}`
        : "",
      process_answer.open.length
        ? `Offen: ${process_answer.open.map((s) => s.text).join(" ")}`
        : "",
    ].filter(Boolean);

    const durationMs = Date.now() - started;
    const retrievalSummary = `${retrieval!.hits.length} Treffer aus ${retrieval!.document_count} Dokumenten [budget=${searchBudget?.stage ?? "n/a"}]`;

    let fullAnalysisReport: FullAnalysisReport | null = null;
    if (searchMode === "full_analysis") {
      try {
        const reportSources = insufficient
          ? hitsByIds(
              retrieval!.hits,
              relevanceGate.similar_but_insufficient_source_ids,
            ).slice(0, 12)
          : sources.length > 0
            ? sources
            : synthesisHits;
        fullAnalysisReport = await buildFullAnalysisReport({
          question,
          processAnswer: process_answer,
          technicalAnswer: technical_answer,
          compactTechnicalDetails: compact_technical_details,
          sources: reportSources,
          retrievalSummary,
          durationMs,
          warnings,
        });
      } catch (reportErr) {
        warnings.push(
          `Report-Erzeugung fehlgeschlagen: ${
            reportErr instanceof Error ? reportErr.message : "unbekannt"
          }`,
        );
      }
    }

    const result: AnswerQuestionResult = {
      status: insufficient ? "insufficient" : "ok",
      question,
      direct_answer: process_answer.direct_answer,
      reasoning: reasoningParts.join("\n"),
      technical_objects: technical_details.called_objects.slice(0, 20),
      uncertainties: process_answer.open_validation_questions,
      process_answer,
      technical_answer,
      technical_details,
      compact_technical_details,
      question_intent: questionIntent.intent,
      evidence_context_report: {
        input_hit_count: evidenceContext.truncation_report.input_hit_count,
        detailed_count: evidenceContext.truncation_report.detailed_count,
        compact_count: evidenceContext.truncation_report.compact_count,
        omitted_count: evidenceContext.truncation_report.omitted_count,
        previously_weak_fields_now_included:
          evidenceContext.truncation_report.previously_weak_fields_now_included,
        notes: evidenceContext.truncation_report.notes,
      },
      entity_grounding: groundingReport.results,
      relevance_gate: relevanceGate,
      sources: insufficient
        ? hitsByIds(
            retrieval!.hits,
            relevanceGate.similar_but_insufficient_source_ids,
          ).slice(0, 5)
        : sources,
      model: AI_CONFIG.chatModel,
      token_usage: { input, output, embedding },
      estimated_cost: estimateCost(input, output, embedding),
      retrieval_summary: retrievalSummary,
      retrieval_mode: mode,
      searched_document_count: retrieval!.document_count,
      top_score: topScore,
      index_path: project.active_index_path,
      vector_search_active: retrieval!.vector_search_active,
      search_mode: searchMode,
      requested_search_mode: requestedMode,
      query_plan: queryPlan,
      subquery_count: subqueryCount,
      planner_fallback: plannerFallback,
      warnings,
      duration_ms: durationMs,
      ...domainMeta,
      prompt_key: capabilities.answerPrompt.key,
      prompt_version: capabilities.answerPrompt.version,
      conversation_mode: false,
      planned_run_id: plannedRunId,
      topic_gate: topicGate,
      full_analysis_report: fullAnalysisReport,
      search_budget: searchBudget?.diagnostics ?? budgetDiag,
    };

    if (params.userId) {
      try {
        await fileHistoryRepository.add({
          user_id: params.userId,
          project_id: project.id,
          question,
          answer: result.direct_answer,
          retrieval_summary: result.retrieval_summary,
          source_refs: result.sources.map((s) => ({
            rank: s.rank,
            source_key: s.source_key,
            title: s.title,
            knowledge_unit_type: s.knowledge_unit_type,
            score: s.combined_score,
          })),
          model: result.model,
          token_usage: result.token_usage,
          estimated_cost: result.estimated_cost,
        });
      } catch (histErr) {
        result.warnings = [
          ...result.warnings,
          `Verlauf konnte nicht gespeichert werden: ${
            histErr instanceof Error ? histErr.message : "unbekannt"
          }`,
        ];
      }
    }

    return result;
  } catch (error) {
    const message =
      error instanceof AIProviderError
        ? error.message
        : error instanceof Error
          ? error.message
          : "OpenAI-Fehler";
    const tech = buildTechnicalDetailsFromHits(retrieval!.hits, mode);
    return {
      status: "error",
      question,
      direct_answer: "",
      reasoning: "",
      technical_objects: tech.called_objects,
      uncertainties: [],
      process_answer: { ...EMPTY_PROCESS_ANSWER },
      technical_answer: enrichTechnicalAnswerFromHits(
        { ...EMPTY_TECHNICAL_ANSWER },
        retrieval!.hits,
      ),
      technical_details: tech,
      compact_technical_details: buildCompactTechnicalDetails({
        hits: retrieval!.hits,
        groundingResults: groundingReport.results,
      }),
      question_intent: questionIntent.intent,
      evidence_context_report: null,
      entity_grounding: groundingReport.results,
      relevance_gate: relevanceGate,
      sources: retrieval!.hits,
      model: AI_CONFIG.chatModel,
      token_usage: {
        input: plannerTokens.input,
        output: plannerTokens.output,
        embedding: retrieval!.query_embedding_tokens,
      },
      estimated_cost:
        estimateCost(plannerTokens.input, plannerTokens.output, 0) +
        retrieval!.query_embedding_cost,
      retrieval_summary: `${retrieval!.hits.length}/${retrieval!.document_count} Treffer`,
      retrieval_mode: mode,
      searched_document_count: retrieval!.document_count,
      top_score: topScore,
      index_path: project.active_index_path,
      vector_search_active: retrieval!.vector_search_active,
      message,
      ...metaExtras,
      duration_ms: Date.now() - started,
    };
  }
}
