"use server";

import {
  canAccessApp,
  canMutateProjectSetup,
  getAccessContext,
} from "@/lib/onboarding/access";
import { answerQuestion } from "@/lib/knowledge/answerQuestion";
import { resolveAskLocalProject } from "@/lib/knowledge/resolveAskProject";
import type {
  AskEvidenceRef,
  AskQuestionInput,
  AskQuestionResult,
} from "@/lib/app/askTypes";

export type {
  AskEvidenceRef,
  AskQuestionInput,
  AskQuestionResult,
} from "@/lib/app/askTypes";
function mapRelevanceGate(
  gate: Awaited<ReturnType<typeof answerQuestion>>["relevance_gate"],
): AskQuestionResult["relevanceGate"] {
  if (!gate) return null;
  return {
    answerability: gate.answerability,
    queryConcepts: gate.query_concepts,
    matchedConcepts: gate.matched_concepts,
    missingConcepts: gate.missing_concepts,
    supportingSourceIds: gate.supporting_source_ids,
    contradictingSourceIds: gate.contradicting_source_ids,
    similarButInsufficientSourceIds: gate.similar_but_insufficient_source_ids,
    reason: gate.reason,
  };
}

function mapEvidence(
  result: Awaited<ReturnType<typeof answerQuestion>>,
): AskEvidenceRef[] {
  return result.sources.map((s) => ({
    title: s.title,
    sourceKey: s.source_key,
    snippet: s.snippet,
    rank: s.rank,
    score: s.combined_score,
    exactScore: s.exact_score,
    fulltextScore: s.fulltext_score,
    vectorScore: s.vector_score,
    knowledgeUnitType: s.knowledge_unit_type,
    objectLabel: [s.object_type, s.object_name, s.subobject_name]
      .filter(Boolean)
      .join(" "),
    objectType: s.object_type,
    objectName: s.object_name,
    subobjectName: s.subobject_name,
    evidenceRefs: s.evidence_refs,
    facts: s.facts,
    inferences: s.inferences,
    tablesRead: s.tables_read,
    tablesWritten: s.tables_written,
    calledMethods: s.called_methods,
    hardcodedValues: s.hardcoded_values,
    evidence: s.evidence,
    confidence: s.doc_confidence ?? s.confidence,
  }));
}

/**
 * Server Action — dieselbe answerQuestion-Pipeline wie POST /api/app/ask und CLI.
 */
export async function askQuestionAction(
  input: AskQuestionInput,
): Promise<AskQuestionResult> {
  const question = input.question.trim();
  if (!question) {
    return {
      status: "error",
      answer: null,
      evidence: [],
      message: "Bitte eine Frage eingeben.",
    };
  }

  const customerId = input.customerId?.trim() || null;
  if (!customerId) {
    return {
      status: "error",
      answer: null,
      evidence: [],
      message:
        "Kein Projekt zugeordnet. Fragen sind nur innerhalb eines Projekts möglich.",
    };
  }

  const ctx = await getAccessContext();
  if (!ctx || !canAccessApp(ctx, customerId)) {
    return {
      status: "error",
      answer: null,
      evidence: [],
      message: "Kein Zugriff auf dieses Projekt.",
    };
  }

  if (
    input.searchMode === "full_analysis" &&
    !canMutateProjectSetup(ctx, customerId)
  ) {
    return {
      status: "error",
      answer: null,
      evidence: [],
      message:
        "Vollanalyse ist nur für General Admin und Projekt-Admin verfügbar.",
      searchMode: "full_analysis",
      requestedSearchMode: "full_analysis",
    };
  }

  const resolved = await resolveAskLocalProject(customerId);
  if (!resolved.ok) {
    if (resolved.detail) {
      console.error("[askQuestionAction] resolve failed:", resolved.detail);
    }
    return {
      status: "error",
      answer: null,
      evidence: [],
      message: resolved.message,
      warnings: [],
    };
  }

  const result = await answerQuestion({
    projectId: resolved.project.id,
    project: resolved.project,
    userId: ctx.userId,
    question,
    searchMode: input.searchMode,
  });

  const evidence = mapEvidence(result);

  if (result.status === "error") {
    return {
      status: "error",
      answer: result.direct_answer || null,
      reasoning: result.reasoning,
      processAnswer: result.process_answer,
      technicalAnswer: result.technical_answer,
      technicalDetails: result.technical_details,
      compactTechnicalDetails: result.compact_technical_details,
      questionIntent: result.question_intent,
      entityGrounding: result.entity_grounding,
      relevanceGate: mapRelevanceGate(result.relevance_gate),
      evidence,
      message: result.message ?? "Frage fehlgeschlagen.",
      retrievalMode: result.retrieval_mode,
      searchedDocumentCount: result.searched_document_count,
      topScore: result.top_score,
      vectorSearchActive: result.vector_search_active,
      model: result.model,
      tokenUsage: result.token_usage,
      estimatedCost: result.estimated_cost,
      warnings: result.warnings,
      indexPath: result.index_path,
      searchMode: result.search_mode,
      requestedSearchMode: result.requested_search_mode,
      queryPlan: result.query_plan,
      subqueryCount: result.subquery_count,
      plannerFallback: result.planner_fallback,
      durationMs: result.duration_ms,
      conversationMode: false as const,
      domainProfileId: result.domain_profile_id,
      promptKey: result.prompt_key,
      promptVersion: result.prompt_version,
      searchProfileId: result.search_profile_id,
      fullAnalysisReport: result.full_analysis_report,
      searchBudget: result.search_budget,
    };
  }

  return {
    status: result.status === "insufficient" ? "insufficient" : "ok",
    answer: result.direct_answer,
    reasoning: result.reasoning,
    processAnswer: result.process_answer,
    technicalAnswer: result.technical_answer,
    technicalDetails: result.technical_details,
    compactTechnicalDetails: result.compact_technical_details,
    questionIntent: result.question_intent,
    entityGrounding: result.entity_grounding,
    relevanceGate: mapRelevanceGate(result.relevance_gate),
    evidence,
    message: result.retrieval_summary,
    retrievalMode: result.retrieval_mode,
    searchedDocumentCount: result.searched_document_count,
    topScore: result.top_score,
    vectorSearchActive: result.vector_search_active,
    model: result.model,
    tokenUsage: result.token_usage,
    estimatedCost: result.estimated_cost,
    warnings: result.warnings,
    indexPath: result.index_path,
    searchMode: result.search_mode,
    requestedSearchMode: result.requested_search_mode,
    queryPlan: result.query_plan,
    subqueryCount: result.subquery_count,
    plannerFallback: result.planner_fallback,
    durationMs: result.duration_ms,
    conversationMode: false as const,
    domainProfileId: result.domain_profile_id,
    promptKey: result.prompt_key,
    promptVersion: result.prompt_version,
    searchProfileId: result.search_profile_id,
    fullAnalysisReport: result.full_analysis_report,
    searchBudget: result.search_budget,
  };
}
