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
  EMPTY_TECHNICAL_DETAILS,
  llmAnswerSchema,
  type CompactTechnicalDetails,
  type ProcessAnswer,
  type TechnicalDetails,
} from "@/lib/knowledge/answerSchema";
import {
  buildCompactTechnicalDetails,
  buildTechnicalDetailsFromHits,
  expandRelatedHits,
  mergeTechnicalDetails,
} from "@/lib/knowledge/buildTechnicalDetails";
import type { QueryPlan, SearchMode } from "@/lib/knowledge/queryPlanSchema";
import { planQuery } from "@/lib/knowledge/queryPlanner";
import {
  listAvailableKnowledgeUnitTypes,
  type AggregatedKnowledgeHit,
} from "@/lib/knowledge/executeQueryPlan";
import { executePlannedRagRetrieval } from "@/lib/knowledge/executePlannedRag";
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

export type AnswerQuestionResult = {
  status: "ok" | "insufficient" | "error";
  question: string;
  /** Flat convenience field = process_answer.direct_answer */
  direct_answer: string;
  reasoning: string;
  technical_objects: string[];
  uncertainties: string[];
  process_answer: ProcessAnswer;
  technical_details: TechnicalDetails;
  /** Compact, max-5-section technical explanation (Quelle/Auslöser/Systemaktion/Beleg/Unsicherheit). */
  compact_technical_details: CompactTechnicalDetails;
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
    technical_details: { ...EMPTY_TECHNICAL_DETAILS },
    compact_technical_details: { ...EMPTY_COMPACT_TECHNICAL_DETAILS },
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

function formatSourcesForPrompt(hits: KnowledgeHit[]): string {
  return hits
    .map((h) => {
      const agg = h as AggregatedKnowledgeHit;
      const facts = h.facts.map((f) => `- FACT: ${f}`).join("\n");
      const inferences = h.inferences
        .map((i) => `- INFERENCE: ${i}`)
        .join("\n");
      const hard = (h.hardcoded_values ?? []).slice(0, 20).join(", ");
      const tables = [
        ...(h.tables_read ?? []).map((t) => `READ ${t}`),
        ...(h.tables_written ?? []).map((t) => `WRITE ${t}`),
      ].join(", ");
      const called = (h.called_methods ?? []).slice(0, 15).join(", ");
      const evidenceLines = (h.evidence ?? [])
        .slice(0, 6)
        .map((e) => {
          const quotes = (e.lines ?? [])
            .slice(0, 3)
            .map((l) => (l.line != null ? `L${l.line}: ${l.quote ?? ""}` : l.quote))
            .filter(Boolean)
            .join(" | ");
          return `- [${e.statement_type}] ${e.text ?? ""} ${quotes}`.trim();
        })
        .join("\n");
      return [
        `### Quelle #${h.rank} | ${h.title}`,
        `source_key: ${h.source_key}`,
        `type: ${h.knowledge_unit_type}`,
        `object: ${h.object_type} ${h.object_name} ${h.subobject_name}`.trim(),
        `score: ${h.combined_score.toFixed(3)}`,
        agg.matched_subqueries?.length
          ? `matched_subqueries: ${agg.matched_subqueries.join(", ")}`
          : "",
        agg.evidence_coverage?.length
          ? `evidence_coverage: ${agg.evidence_coverage.join(", ")}`
          : "",
        `confidence: ${h.doc_confidence ?? h.confidence ?? "—"}`,
        `snippet: ${h.snippet}`,
        h.technical_summary ? `technical_summary: ${h.technical_summary}` : "",
        h.business_purpose ? `business_purpose: ${h.business_purpose}` : "",
        tables ? `tables: ${tables}` : "",
        called ? `called_methods: ${called}` : "",
        hard ? `hardcoded_values: ${hard}` : "",
        facts,
        inferences,
        evidenceLines ? `evidence:\n${evidenceLines}` : "",
        h.evidence_refs.length
          ? `evidence_refs: ${h.evidence_refs.slice(0, 8).join(" | ")}`
          : "",
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n");
}

function retrievalModeLabel(vectorActive: boolean, hasEmbeddings: boolean): string {
  if (vectorActive) return "hybrid (exact + fulltext + vector)";
  if (hasEmbeddings) return "lexical (exact + fulltext; vector skipped)";
  return "lexical (exact + fulltext)";
}

const ANSWER_SCHEMA_HINT = `
Ausgabeformat: strukturiertes JSON gemäß dem vorgegebenen Schema
(process_answer + technical_details + insufficient_evidence + source_ranks_used).
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
  const requestedMode: SearchMode =
    params.searchMode === "planned_rag" ? "planned_rag" : "direct_rag";
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

  try {
    if (searchMode === "planned_rag") {
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
        warnings.push(...executed.warnings);
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
      const direct = await KnowledgeRetriever.search({
        project,
        query: question,
        limit: params.limit ?? 12,
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
      searchMode === "planned_rag" && queryPlan
        ? capabilities.plannerPrompt.key
        : capabilities.answerPrompt.key,
    prompt_version:
      searchMode === "planned_rag" && queryPlan
        ? capabilities.plannerPrompt.version
        : capabilities.answerPrompt.version,
    conversation_mode: false as const,
  };

  if (retrieval!.hits.length === 0) {
    const pa: ProcessAnswer = {
      ...EMPTY_PROCESS_ANSWER,
      direct_answer:
        "Im aktuell indexierten Wissensbestand nicht belastbar beantwortbar.",
      open_validation_questions: [
        "Keine passenden SearchDocuments gefunden.",
      ],
    };
    return {
      status: "insufficient",
      question,
      direct_answer: pa.direct_answer,
      reasoning: "Die Suche lieferte keine Treffer.",
      technical_objects: [],
      uncertainties: pa.open_validation_questions,
      process_answer: pa,
      technical_details: {
        ...EMPTY_TECHNICAL_DETAILS,
        retrieval_mode: mode,
      },
      compact_technical_details: { ...EMPTY_COMPACT_TECHNICAL_DETAILS },
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
    const pa: ProcessAnswer = {
      ...EMPTY_PROCESS_ANSWER,
      direct_answer:
        "Im aktuell indexierten Wissensbestand wurde keine belastbare Quelle gefunden, die diese Frage beantwortet.",
      open_validation_questions: [
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
      ].filter(Boolean),
    };
    return {
      status: "insufficient",
      question,
      direct_answer: pa.direct_answer,
      reasoning: relevanceGate.reason,
      technical_objects: [],
      uncertainties: pa.open_validation_questions,
      process_answer: pa,
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
    relevanceGate.supporting_source_ids.length > 0
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
      technical_details: tech,
      compact_technical_details: buildCompactTechnicalDetails({
        hits: synthesisHits,
        groundingResults: groundingReport.results,
      }),
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
      timeout: AI_CONFIG.timeoutMs,
      maxRetries: AI_CONFIG.maxRetries,
    });
    const planBlock =
      searchMode === "planned_rag" && queryPlan
        ? [
            "",
            "Suchmodus: planned_rag (KI-Tiefensuche)",
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

    const userPrompt = [
      `Frage: ${question}`,
      planBlock,
      groundingBlock,
      relevanceBlock,
      "",
      "Quellen (nur relevante/unterstützende Treffer):",
      formatSourcesForPrompt(synthesisHits),
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
            `Domain Profile: ${capabilities.domainProfileId}@${capabilities.domainProfile.version}`,
            `Suchmodus: ${searchMode}`,
            "conversation_mode=false — beantworte nur die aktuelle Frage aus den aktuellen Quellen.",
          ].join("\n\n"),
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
    const usedRanks = new Set(validated.source_ranks_used);
    let sources =
      usedRanks.size > 0
        ? synthesisHits.filter((h) => usedRanks.has(h.rank))
        : synthesisHits;
    // Partial answers: if the model refused ranks, still surface supporting hits.
    if (
      sources.length === 0 &&
      relevanceGate.answerability === "partially_answerable"
    ) {
      sources = synthesisHits.slice(0, 8);
    }

    // Deterministic gate — never trust the LLM's insufficient_evidence flag
    // alone for named-entity transfer; grounding was computed before synthesis.
    // When the relevance gate already classified answerable/partial, do not let
    // the LLM collapse a partial answer into a full refusal.
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

    const insufficient =
      hasUngroundedNamedEntity ||
      (validated.insufficient_evidence && !gateAllowsAnswer) ||
      (!validated.process_answer.direct_answer.trim() &&
        sources.length === 0 &&
        !gateAllowsAnswer);

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

    // Neighbor evidence (contradicted entities only) — surfaced transparently
    // in compact technical details, never as an answer to the question asked.
    const neighborRanks = new Set(
      ungroundedNamed
        .filter((r) => r.grounding_status === "contradicted")
        .flatMap((r) => r.evidence_refs)
        .map((ref) => Number(ref.match(/^#(\d+)/)?.[1]))
        .filter((n): n is number => Number.isFinite(n)),
    );
    const neighborHits = retrieval!.hits.filter((h) => neighborRanks.has(h.rank));

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

    const process_answer: ProcessAnswer = insufficient
      ? {
          ...EMPTY_PROCESS_ANSWER,
          direct_answer: hasUngroundedNamedEntity
            ? `Für „${ungroundedNamed.map((r) => r.query_entity).join(", ")}“ liegt im aktuell indexierten Wissensbestand keine belastbare, entitätsspezifische Regel vor.`
            : "Im aktuell indexierten Wissensbestand nicht belastbar beantwortbar.",
          business_interpretation: (() => {
            const neighbors = similarNeighborEntities(groundingReport);
            if (neighbors.length === 0) return "";
            return `Ähnliche gefundene Regel (nicht anwendbar): Für ${neighbors.join(", ")} liegt eine belegte Regel vor — diese gilt nicht automatisch für „${ungroundedNamed.map((r) => r.query_entity).join(", ")}“ und wurde nicht übertragen.`;
          })(),
          open_validation_questions: hasUngroundedNamedEntity
            ? [
                ...ungroundedNamed.map(
                  (r) => `Für „${r.query_entity}“ (${r.entity_type}): ${r.reason}`,
                ),
                ...validated.process_answer.open_validation_questions,
              ]
            : validated.process_answer.open_validation_questions.length > 0
              ? validated.process_answer.open_validation_questions
              : ["Quellen reichen für eine belastbare Antwort nicht aus."],
        }
      : {
          direct_answer:
            validated.process_answer.direct_answer.trim() ||
            (relevanceGate.answerability === "partially_answerable"
              ? `Nur teilweise belegbar. Belegt: ${relevanceGate.matched_concepts.join(", ") || "—"}. Nicht belegt: ${relevanceGate.missing_concepts.join(", ") || "—"}.`
              : ""),
          special_process: validated.process_answer.special_process.trim(),
          trigger: validated.process_answer.trigger.trim(),
          process_effect: validated.process_answer.process_effect.trim(),
          business_interpretation:
            validated.process_answer.business_interpretation.trim(),
          open_validation_questions: [
            ...validated.process_answer.open_validation_questions,
            ...(relevanceGate.answerability === "partially_answerable"
              ? [
                  relevanceGate.reason,
                  ...relevanceGate.missing_concepts.map(
                    (c) => `Nicht belegt / offen: ${c}`,
                  ),
                ]
              : []),
          ],
        };

    const reasoningParts = [
      process_answer.special_process &&
        `Besonderheit: ${process_answer.special_process}`,
      process_answer.trigger && `Auslöser: ${process_answer.trigger}`,
      process_answer.process_effect &&
        `Wirkung: ${process_answer.process_effect}`,
      process_answer.business_interpretation &&
        `Bedeutung: ${process_answer.business_interpretation}`,
    ].filter(Boolean);

    const result: AnswerQuestionResult = {
      status: insufficient ? "insufficient" : "ok",
      question,
      direct_answer: process_answer.direct_answer,
      reasoning: reasoningParts.join("\n"),
      technical_objects: technical_details.called_objects.slice(0, 20),
      uncertainties: process_answer.open_validation_questions,
      process_answer,
      technical_details,
      compact_technical_details,
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
      retrieval_summary: `${retrieval!.hits.length} Treffer aus ${retrieval!.document_count} Dokumenten`,
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
      duration_ms: Date.now() - started,
      ...domainMeta,
      prompt_key: capabilities.answerPrompt.key,
      prompt_version: capabilities.answerPrompt.version,
      conversation_mode: false,
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
      technical_details: tech,
      compact_technical_details: buildCompactTechnicalDetails({
        hits: retrieval!.hits,
        groundingResults: groundingReport.results,
      }),
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
