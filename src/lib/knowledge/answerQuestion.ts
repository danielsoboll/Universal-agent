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
import { runStandardAnchorRag } from "@/lib/knowledge/anchorRag/runStandardAnchorRag";
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
import type { InventoryDiagnostics } from "@/lib/knowledge/inventoryAggregation";
import type { InventoryAnswerView } from "@/lib/knowledge/inventoryAggregation";
import {
  runAskOrchestration,
  type AskOrchestrationDiagnostics,
} from "@/lib/knowledge/askOrchestration";
import {
  classifyHardcodedValueIntent,
  runHardcodedValueInventoryResolver,
  slimHardcodedValueAnswerForClient,
} from "@/lib/knowledge/hardcodedValueInventory";
import { buildHardcodedUserAnswers } from "@/lib/knowledge/hardcodedValueInventory/buildHardcodedUserAnswers";

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
  /** Inventory/aggregation resolver diagnostics (set/list questions). */
  inventory_aggregation: InventoryDiagnostics | null;
  /** Structured inventory answer for card UI (no markdown tables). */
  inventory_answer: InventoryAnswerView | null;
  /** Structured entity-list answer for card UI (classes/programs/…). */
  entity_list_answer: import("@/lib/knowledge/entityListAggregation").EntityListAnswerView | null;
  /** Structured hardcoded-value inventory for card UI. */
  hardcoded_value_answer: import("@/lib/knowledge/hardcodedValueInventory").HardcodedValueAnswerView | null;
  /** Structured process explanation UI (gated evidence). */
  process_answer_view: import("@/lib/knowledge/askOrchestration/relevanceGateTypes").ProcessAnswerView | null;
  /** Unified structured product answer. */
  structured_answer: import("@/lib/knowledge/structuredAnswer").StructuredAnswer | null;
  /** Generic ask orchestration diagnostics (intent/graph/budget/claims). */
  ask_orchestration: AskOrchestrationDiagnostics | null;
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
    inventory_aggregation: null,
    inventory_answer: null,
    entity_list_answer: null,
    hardcoded_value_answer: null,
    process_answer_view: null,
    structured_answer: null,
    ask_orchestration: null,
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

  // --- Generic ask orchestration (intent → graph-first / inventory) ---
  // No question hardcoding; inventory stays canonical; process/trace avoid Top-k-first.
  try {
    const orch = await runAskOrchestration({ question });
    if (orch.used && !orch.handoff_to_hybrid) {
      const hcView = orch.hardcoded_value_answer;
      const hcUserAnswers =
        orch.intent === "HARDCODED_VALUE_INVENTORY" && hcView
          ? buildHardcodedUserAnswers(hcView)
          : null;

      const process_answer: ProcessAnswer = hcUserAnswers
        ? hcUserAnswers.process_answer
        : {
            ...EMPTY_PROCESS_ANSWER,
            direct_answer: orch.answer_markdown,
            confirmed: orch.claims
              .filter(
                (c) =>
                  c.strength === "AUTHORITATIVE" ||
                  c.strength === "CODE_DERIVED",
              )
              .slice(0, 12)
              .map((c) => ({
                text: c.text,
                level: "confirmed" as const,
                source_ranks: [1],
                source_ids: [],
              })),
            inferred: orch.claims
              .filter((c) => c.strength === "INFERRED")
              .slice(0, 8)
              .map((c) => ({
                text: c.text.startsWith("Ableitung:")
                  ? c.text
                  : `Ableitung: ${c.text}`,
                level: "inferred" as const,
                source_ranks: [],
                source_ids: [],
              })),
            has_safe_process_claim: orch.status === "ok",
            open_validation_questions:
              orch.diagnostics.evidence_coverage.missing,
          };

      const technical_answer: TechnicalAnswer = hcUserAnswers
        ? hcUserAnswers.technical_answer
        : {
            ...EMPTY_TECHNICAL_ANSWER,
            processing: orch.diagnostics.graph_paths.slice(0, 10).map((p) => ({
              text: `${p.object_name}.${p.unit_name} [${p.cache_status}] ${p.path_relations.join(" → ")}`,
              level: "confirmed" as const,
              source_ranks: [1],
              source_ids: [],
            })),
            open: orch.diagnostics.evidence_coverage.missing.map((m) => ({
              text: m,
              level: "possible" as const,
              source_ranks: [],
              source_ids: [],
            })),
          };

      return {
        status: orch.status === "ok" ? "ok" : "insufficient",
        question,
        direct_answer: orch.answer_markdown,
        reasoning: `Ask-Orchestrierung (${orch.intent}) — Graph-first / Canonical, kein Top-k-First.`,
        technical_objects: orch.diagnostics.seeds,
        uncertainties: [
          ...orch.diagnostics.evidence_coverage.missing,
          ...orch.diagnostics.discarded_unsupported_claims.map(
            (d) => `verworfen: ${d.text}`,
          ),
        ],
        process_answer,
        technical_answer,
        technical_details: hcUserAnswers
          ? hcUserAnswers.technical_details
          : { ...EMPTY_TECHNICAL_DETAILS },
        compact_technical_details: hcUserAnswers
          ? hcUserAnswers.compact_technical_details
          : { ...EMPTY_COMPACT_TECHNICAL_DETAILS },
        question_intent: orch.intent,
        evidence_context_report: null,
        entity_grounding: [],
        relevance_gate: null,
        sources: [],
        model: "deterministic/ask_orchestration",
        token_usage: { input: 0, output: 0, embedding: 0 },
        estimated_cost: 0,
        retrieval_summary: `ask_orchestration intent=${orch.intent} seeds=${orch.diagnostics.seeds.length} paths=${orch.diagnostics.graph_paths.length} cache=${orch.diagnostics.cached_method_analyses.length}`,
        retrieval_mode: "ask_orchestration",
        searched_document_count: orch.diagnostics.graph_paths.length,
        top_score: null,
        index_path: orch.diagnostics.canonical_sources[0] ?? "",
        vector_search_active: false,
        warnings: [],
        search_mode: searchMode,
        requested_search_mode: requestedMode,
        query_plan: null,
        subquery_count: 0,
        planner_fallback: false,
        duration_ms: Date.now() - started,
        conversation_mode: false,
        planned_run_id: null,
        topic_gate: null,
        full_analysis_report: null,
        inventory_aggregation: orch.diagnostics.inventory,
        inventory_answer: orch.inventory_answer ?? null,
        entity_list_answer: orch.entity_list_answer ?? null,
        hardcoded_value_answer: slimHardcodedValueAnswerForClient(
          orch.hardcoded_value_answer ?? null,
        ),
        process_answer_view: orch.process_answer_view ?? null,
        structured_answer: orch.structured_answer ?? null,
        ask_orchestration: orch.diagnostics,
        ...domainMeta,
      };
    }
  } catch (e) {
    warnings.push(
      `ask_orchestration failed: ${e instanceof Error ? e.message : String(e)}`,
    );
    // Fail closed for hardcoded-value questions: still deliver deterministic scan.
    const hcClass = classifyHardcodedValueIntent(question);
    if (hcClass.intent === "HARDCODED_VALUE_INVENTORY") {
      try {
        const hc = await runHardcodedValueInventoryResolver({ question });
        if (hc.used && hc.answer_view) {
          const slim = slimHardcodedValueAnswerForClient(hc.answer_view);
          const userAnswers = buildHardcodedUserAnswers(hc.answer_view);
          return {
            status: slim && slim.materials.length > 0 ? "ok" : "insufficient",
            question,
            direct_answer: hc.summary_sentence,
            reasoning:
              "Ask-Orchestrierung fehlgeschlagen — Hardcoded-Value-Resolver als Fallback.",
            technical_objects: [],
            uncertainties: warnings,
            process_answer: userAnswers.process_answer,
            technical_answer: userAnswers.technical_answer,
            technical_details: userAnswers.technical_details,
            compact_technical_details: userAnswers.compact_technical_details,
            question_intent: "HARDCODED_VALUE_INVENTORY",
            evidence_context_report: null,
            entity_grounding: [],
            relevance_gate: null,
            sources: [],
            model: "deterministic/hardcoded_value_fallback",
            token_usage: { input: 0, output: 0, embedding: 0 },
            estimated_cost: 0,
            retrieval_summary: "hardcoded_value_inventory fallback",
            retrieval_mode: "ask_orchestration",
            searched_document_count: 0,
            top_score: null,
            index_path: hc.sources[0] ?? "",
            vector_search_active: false,
            warnings,
            search_mode: searchMode,
            requested_search_mode: requestedMode,
            query_plan: null,
            subquery_count: 0,
            planner_fallback: false,
            duration_ms: Date.now() - started,
            conversation_mode: false,
            planned_run_id: null,
            topic_gate: null,
            full_analysis_report: null,
            inventory_aggregation: null,
            inventory_answer: null,
            entity_list_answer: null,
            hardcoded_value_answer: slim,
            process_answer_view: null,
            structured_answer: null,
            ask_orchestration: null,
            ...domainMeta,
          };
        }
      } catch (fallbackErr) {
        warnings.push(
          `hardcoded_value fallback failed: ${fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)}`,
        );
      }
    }
  }

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

  // --- Standard Anchor-RAG (direct_rag / planned_rag): no deep planning round ---
  if (searchMode === "direct_rag" || searchMode === "planned_rag") {
    try {
      const std = await runStandardAnchorRag({
        project,
        question,
        synthesize: true,
      });
      if (std.used && std.anchor) {
        const pkg = std.anchor.evidence_package;
        const process_answer: ProcessAnswer = {
          ...EMPTY_PROCESS_ANSWER,
          direct_answer: std.direct_answer,
          confirmed: [
            {
              text: std.direct_answer,
              level: "confirmed",
              source_ranks: [1],
              source_ids: [],
            },
          ],
          open: std.open_questions.map((t) => ({
            text: t,
            level: "possible" as const,
            source_ranks: [],
            source_ids: [],
          })),
          has_safe_process_claim: true,
          open_validation_questions: std.open_questions,
        };
        const result: AnswerQuestionResult = {
          status: "ok",
          question,
          direct_answer: std.direct_answer,
          reasoning: std.reasoning,
          technical_objects: pkg.code_units
            .slice(0, 20)
            .map((u) => String((u as { name?: string }).name ?? ""))
            .filter((n) => n && n !== "?"),
          uncertainties: std.open_questions,
          process_answer,
          technical_answer: {
            ...EMPTY_TECHNICAL_ANSWER,
            processing: [
              ...pkg.proven_claims.slice(0, 12).map((c) => ({
                text: c,
                level: "confirmed" as const,
                source_ranks: [1],
                source_ids: [],
              })),
              ...(std.anchor.medium_resolutions ?? []).map((m) => {
                const mm = m as {
                  medium_code?: string;
                  medium_text?: string;
                  resolution?: string;
                };
                return {
                  text: `Medium-Text-Auflösung (technisch): NACHA=${mm.medium_code} → „${mm.medium_text}“ (Quelle: ${mm.resolution})`,
                  level: "confirmed" as const,
                  source_ranks: [1],
                  source_ids: [],
                };
              }),
            ],
            open: std.open_questions.map((c) => ({
              text: c,
              level: "possible" as const,
              source_ranks: [],
              source_ids: [],
            })),
          },
          technical_details: { ...EMPTY_TECHNICAL_DETAILS },
          compact_technical_details: { ...EMPTY_COMPACT_TECHNICAL_DETAILS },
          question_intent: classifyQuestionIntent(question),
          evidence_context_report: null,
          entity_grounding: [],
          relevance_gate: null,
          sources: std.sources_used.map((s, i) => ({
            rank: i + 1,
            source_key: s,
            title: s,
            knowledge_unit_type: "code_unit",
            combined_score: 1,
            snippet: s.slice(0, 200),
          })),
          model: std.model,
          token_usage: std.token_usage,
          estimated_cost: estimateCost(
            std.token_usage.input,
            std.token_usage.output,
            std.token_usage.embedding,
          ),
          retrieval_summary: `Anchor-RAG: nodes=${std.anchor.graph.nodes.length} edges=${std.anchor.graph.edges.length} hits=${std.anchor.metrics.inventory_hits} scanned=${std.anchor.metrics.documents_scanned}`,
          retrieval_mode: "standard_anchor_rag",
          searched_document_count: std.anchor.metrics.focused
            ? std.anchor.metrics.inventory_hits + std.anchor.graph.nodes.length
            : std.anchor.metrics.documents_scanned ||
              std.anchor.graph.nodes.length,
          top_score: null,
          index_path: project.active_index_path ?? "",
          vector_search_active: false,
          warnings: [
            `standard_anchor_rag log=${std.log_dir}`,
            `tnapr=${JSON.stringify(std.anchor.tnapr_resolutions?.length ?? 0)}`,
          ],
          message: "",
          search_mode: searchMode,
          requested_search_mode: requestedMode,
          query_plan: null,
          subquery_count: 1,
          planner_fallback: false,
          duration_ms: Date.now() - started,
          domain_profile_id: domainMeta.domain_profile_id as AnswerQuestionResult["domain_profile_id"],
          prompt_key: domainMeta.prompt_key,
          prompt_version: domainMeta.prompt_version,
          search_profile_id: domainMeta.search_profile_id,
          workflow_template_id: domainMeta.workflow_template_id,
          conversation_mode: false,
          planned_run_id: null,
          topic_gate: null,
          full_analysis_report: null,
          inventory_aggregation: null,
          inventory_answer: null,
          entity_list_answer: null,
          hardcoded_value_answer: null,
          process_answer_view: null,
          structured_answer: null,
          ask_orchestration: null,
        };
        console.info(
          "[answerQuestion:standard_anchor_rag]",
          JSON.stringify({
            mode: searchMode,
            log_dir: std.log_dir,
            nodes: std.anchor.graph.nodes.length,
            edges: std.anchor.graph.edges.length,
          }),
        );
        return result;
      }
    } catch (e) {
      warnings.push(
        `Standard-Anchor-RAG übersprungen: ${e instanceof Error ? e.message : "error"}`,
      );
      console.warn("[answerQuestion] standard_anchor_rag failed:", e);
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
      // direct_rag path unchanged — fast hybrid (+ exact-symbol pre-pass in hybridSearch).
      // Query-Understanding / Multi-Source belong exclusively to deep_search.
      const direct = await KnowledgeRetriever.search({
        project,
        query: question,
        limit: params.limit ?? 40,
        searchProfile: capabilities.searchProfile,
      });
      retrieval = {
        hits: direct.hits,
        document_count: direct.document_count,
        vector_search_active: direct.vector_search_active,
        index_path: direct.index_path,
        query_embedding_tokens: direct.query_embedding_tokens,
        query_embedding_cost: direct.query_embedding_cost,
        warnings: direct.warnings,
      };
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

  const metaExtras = {
    search_mode: searchMode,
    requested_search_mode: requestedMode,
    query_plan: queryPlan,
    subquery_count: subqueryCount,
    planner_fallback: plannerFallback,
    duration_ms: Date.now() - started,
    warnings: [...warnings],
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
    inventory_aggregation: null as InventoryDiagnostics | null,
    inventory_answer: null as InventoryAnswerView | null,
    entity_list_answer: null,
    hardcoded_value_answer: null,
    process_answer_view: null,
    structured_answer: null,
    ask_orchestration: null as AskOrchestrationDiagnostics | null,
  };

  const questionIntent = classifyQuestionIntent(question);

  if (retrieval!.hits.length === 0) {
    const pa: ProcessAnswer = {
      ...EMPTY_PROCESS_ANSWER,
      direct_answer:
        "Im aktuell indexierten Wissensbestand nicht belastbar beantwortbar.",
      open_validation_questions: [
        "Keine passenden SearchDocuments gefunden.",
      ],
      open: [
        {
          text: "Keine passenden SearchDocuments gefunden.",
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
      reasoning: "Die Suche lieferte keine Treffer.",
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
      retrieval_summary: `0/${retrieval!.document_count} Treffer`,
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
    const openNotes = [
      relevanceGate.reason,
      relevanceGate.missing_concepts.length
        ? `Fehlende zentrale Belege: ${relevanceGate.missing_concepts.join(", ")}`
        : "",
      relevanceGate.query_concepts.length
        ? `Gesuchte Konzepte: ${relevanceGate.query_concepts.join(", ")}`
        : "",
      similarHits.length
        ? "Es liegen nur ähnliche, aber nicht ausreichend passende Treffer vor (siehe Quellen)."
        : "",
    ].filter(Boolean);
    const pa: ProcessAnswer = {
      ...EMPTY_PROCESS_ANSWER,
      direct_answer:
        "Im aktuell indexierten Wissensbestand wurde keine belastbare Quelle gefunden, die diese Frage beantwortet.",
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
        evidence: similarHits.map(
          (h) =>
            `Ähnlicher, nicht ausreichender Treffer: ${h.title || h.source_key}`,
        ),
      },
      compact_technical_details: {
        ...EMPTY_COMPACT_TECHNICAL_DETAILS,
        unsicherheit: pa.open_validation_questions,
      },
      question_intent: questionIntent.intent,
      evidence_context_report: null,
      entity_grounding: groundingReport.results,
      relevance_gate: relevanceGate,
      sources: similarHits,
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
    searchMode === "full_analysis" || searchMode === "direct_rag"
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
      sources = synthesisHits.slice(0, 24);
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
    const retrievalSummary = `${retrieval!.hits.length} Treffer aus ${retrieval!.document_count} Dokumenten`;

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
      inventory_aggregation: null,
      inventory_answer: null,
      entity_list_answer: null,
      hardcoded_value_answer: null,
      process_answer_view: null,
      structured_answer: null,
      ask_orchestration: null,
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
