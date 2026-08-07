import { NextResponse } from "next/server";
import { z } from "zod";
import {
  canAccessApp,
  canMutateProjectSetup,
  getAccessContext,
} from "@/lib/onboarding/access";
import { answerQuestion } from "@/lib/knowledge/answerQuestion";
import { resolveAskLocalProject } from "@/lib/knowledge/resolveAskProject";

export const runtime = "nodejs";
/** Lokaler Index + OpenAI — Vollanalyse kann länger laufen. */
export const maxDuration = 180;

const bodySchema = z.object({
  question: z.string().min(1).max(4000),
  projectId: z.string().uuid().or(z.string().min(1)),
  searchMode: z
    .enum(["direct_rag", "planned_rag", "full_analysis", "deep_search"])
    .optional(),
  /** Accepted but ignored — ask is always isolated (no chat memory). */
  conversationMode: z.literal(false).optional(),
});

function mapSource(s: Awaited<ReturnType<typeof answerQuestion>>["sources"][number]) {
  return {
    rank: s.rank,
    title: s.title,
    sourceKey: s.source_key,
    knowledgeUnitType: s.knowledge_unit_type,
    objectType: s.object_type,
    objectName: s.object_name,
    subobjectName: s.subobject_name,
    snippet: s.snippet,
    score: s.combined_score,
    exactScore: s.exact_score,
    fulltextScore: s.fulltext_score,
    vectorScore: s.vector_score,
    evidenceRefs: s.evidence_refs,
    facts: s.facts,
    inferences: s.inferences,
    tablesRead: s.tables_read,
    tablesWritten: s.tables_written,
    calledMethods: s.called_methods,
    hardcodedValues: s.hardcoded_values,
    evidence: s.evidence,
    confidence: s.doc_confidence ?? s.confidence,
  };
}

export async function POST(request: Request) {
  const ctx = await getAccessContext();
  if (!ctx) {
    return NextResponse.json(
      { status: "error", message: "Nicht angemeldet." },
      { status: 401 },
    );
  }

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return NextResponse.json(
      { status: "error", message: "Ungültiger JSON-Body." },
      { status: 400 },
    );
  }

  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      {
        status: "error",
        message: "question und projectId sind erforderlich.",
        details: parsed.error.flatten(),
      },
      { status: 400 },
    );
  }

  const { question, projectId, searchMode } = parsed.data;

  if (!canAccessApp(ctx, projectId)) {
    return NextResponse.json(
      {
        status: "error",
        message: "Kein Zugriff auf dieses Projekt.",
      },
      { status: 403 },
    );
  }

  if (
    !ctx.isPlatformAdmin &&
    !ctx.isGeneralAdmin &&
    ctx.customerId &&
    ctx.customerId !== projectId &&
    !ctx.memberships.some((m) => m.customer_id === projectId)
  ) {
    return NextResponse.json(
      { status: "error", message: "Projektzugriff verweigert." },
      { status: 403 },
    );
  }

  if (
    searchMode === "full_analysis" &&
    !canMutateProjectSetup(ctx, projectId)
  ) {
    return NextResponse.json(
      {
        status: "error",
        message:
          "Vollanalyse ist nur für General Admin und Projekt-Admin verfügbar.",
        searchMode: "full_analysis",
        requestedSearchMode: "full_analysis",
      },
      { status: 403 },
    );
  }

  const resolved = await resolveAskLocalProject(projectId);
  if (!resolved.ok) {
    if (resolved.detail) {
      console.error("[api/app/ask] resolve failed:", resolved.detail);
    }
    const status = resolved.code === "unavailable" ? 503 : 404;
    return NextResponse.json(
      {
        status: "error",
        message: resolved.message,
        answer: null,
        processAnswer: null,
        technicalAnswer: null,
        technicalDetails: null,
        compactTechnicalDetails: null,
        questionIntent: null,
        entityGrounding: [],
        sources: [],
        retrievalMode: "none",
        searchedDocumentCount: 0,
        topScore: null,
        model: null,
        tokenUsage: { input: 0, output: 0, embedding: 0 },
        estimatedCost: 0,
        warnings: [],
        searchMode: searchMode ?? "direct_rag",
        requestedSearchMode: searchMode ?? "direct_rag",
        queryPlan: null,
        subqueryCount: 0,
        plannerFallback: false,
        durationMs: 0,
      },
      { status },
    );
  }

  const result = await answerQuestion({
    projectId: resolved.project.id,
    project: resolved.project,
    userId: ctx.userId,
    question,
    searchMode,
  });

  const httpStatus =
    result.status === "error" && result.message?.includes("OPENAI")
      ? 503
      : 200;

  return NextResponse.json(
    {
      status: result.status,
      answer: result.direct_answer || null,
      reasoning: result.reasoning || null,
      processAnswer: result.process_answer,
      technicalAnswer: result.technical_answer,
      technicalDetails: result.technical_details,
      compactTechnicalDetails: result.compact_technical_details,
      questionIntent: result.question_intent,
      entityGrounding: result.entity_grounding,
      relevanceGate: result.relevance_gate
        ? {
            answerability: result.relevance_gate.answerability,
            queryConcepts: result.relevance_gate.query_concepts,
            matchedConcepts: result.relevance_gate.matched_concepts,
            missingConcepts: result.relevance_gate.missing_concepts,
            supportingSourceIds: result.relevance_gate.supporting_source_ids,
            contradictingSourceIds:
              result.relevance_gate.contradicting_source_ids,
            similarButInsufficientSourceIds:
              result.relevance_gate.similar_but_insufficient_source_ids,
            reason: result.relevance_gate.reason,
          }
        : null,
      technicalObjects: result.technical_objects,
      uncertainties: result.uncertainties,
      sources: result.sources.map(mapSource),
      retrievalMode: result.retrieval_mode,
      searchedDocumentCount: result.searched_document_count,
      topScore: result.top_score,
      indexPath: result.index_path,
      vectorSearchActive: result.vector_search_active,
      model: result.model,
      tokenUsage: result.token_usage,
      estimatedCost: result.estimated_cost,
      warnings: result.warnings,
      message: result.message ?? null,
      retrievalSummary: result.retrieval_summary,
      searchMode: result.search_mode,
      requestedSearchMode: result.requested_search_mode,
      queryPlan: result.query_plan,
      subqueryCount: result.subquery_count,
      plannerFallback: result.planner_fallback,
      durationMs: result.duration_ms,
      conversationMode: false,
      domainProfileId: result.domain_profile_id,
      promptKey: result.prompt_key,
      promptVersion: result.prompt_version,
      searchProfileId: result.search_profile_id,
      fullAnalysisReport: result.full_analysis_report,
    },
    { status: httpStatus },
  );
}
