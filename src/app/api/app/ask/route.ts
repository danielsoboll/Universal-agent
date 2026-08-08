import { NextResponse } from "next/server";
import { z } from "zod";
import {
  canAccessApp,
  canMutateProjectSetup,
  getAccessContext,
} from "@/lib/onboarding/access";

export const runtime = "nodejs";
/** Lokaler Index + OpenAI — Expansion/Vollanalyse kann länger laufen. */
export const maxDuration = 600;

const bodySchema = z.object({
  question: z.string().min(1).max(4000),
  projectId: z.string().uuid().or(z.string().min(1)),
  searchMode: z
    .enum(["direct_rag", "planned_rag", "full_analysis", "deep_search"])
    .optional(),
  /** Accepted but ignored — ask is always isolated (no chat memory). */
  conversationMode: z.literal(false).optional(),
  /** Measurement only: force cold warm-state for askPerf. */
  askPerfForceCold: z.boolean().optional(),
  expandMissingRelationKnowledge: z.boolean().optional(),
  expandAnalysisBudget: z.number().int().min(1).max(25).optional(),
});

type AskSource = {
  rank: number;
  title: string;
  source_key?: string;
  knowledge_unit_type?: string;
  object_type?: string;
  object_name?: string;
  subobject_name?: string;
  snippet?: string;
  combined_score?: number;
  exact_score?: number;
  fulltext_score?: number;
  vector_score?: number;
  evidence_refs?: string[];
  facts?: string[];
  inferences?: string[];
  tables_read?: string[];
  tables_written?: string[];
  called_methods?: string[];
  hardcoded_values?: string[];
  evidence?: unknown;
  doc_confidence?: number | null;
  confidence?: number | null;
};

function mapSource(s: AskSource) {
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
  const routeEnteredAt = performance.now();
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

  const {
    question,
    projectId,
    searchMode,
    askPerfForceCold,
    expandMissingRelationKnowledge,
    expandAnalysisBudget,
  } = parsed.data;

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

  if (
    expandMissingRelationKnowledge &&
    !canMutateProjectSetup(ctx, projectId)
  ) {
    return NextResponse.json(
      {
        status: "error",
        message:
          "„Fehlendes Beziehungswissen ergänzen“ ist nur für General Admin und Projekt-Admin verfügbar.",
      },
      { status: 403 },
    );
  }

  // Lazy: Knowledge modules only after auth + only inside this Ask request.
  const [
    { answerQuestion, finalizeAskPerfOnResult },
    { resolveAskLocalProject },
    { formatServerTiming, askPerfMark, askPerfNote, runWithAskPerf },
  ] = await Promise.all([
    import("@/lib/knowledge/answerQuestion"),
    import("@/lib/knowledge/resolveAskProject"),
    import("@/lib/knowledge/askPerf"),
  ]);

  const forceColdHeader =
    request.headers.get("x-ask-perf-cold") === "1" ||
    askPerfForceCold === true;

  return runWithAskPerf(
    {
      question,
      forceCold: forceColdHeader ? true : undefined,
    },
    async () => {
      askPerfMark("api_route_entered");
      askPerfNote(
        `pre_als_auth_ms=${(performance.now() - routeEnteredAt).toFixed(1)}; NODE_ENV=${process.env.NODE_ENV}; TURBOPACK=${process.env.TURBOPACK ?? ""}`,
      );

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
            askPerf: null,
          },
          { status },
        );
      }

      const raw = await answerQuestion({
        projectId: resolved.project.id,
        project: resolved.project,
        userId: ctx.userId,
        question,
        searchMode,
        expandMissingRelationKnowledge,
        expandAnalysisBudget,
      });
      askPerfMark("api_response_sent");
      const result = finalizeAskPerfOnResult(raw);

      if (result.ask_perf) {
        console.info(
          "[askPerf]",
          JSON.stringify({
            cold_or_warm: result.ask_perf.cold_or_warm,
            total_ms: result.ask_perf.total_ms,
            phases: result.ask_perf.phases,
            openai_calls: result.ask_perf.openai_calls,
            openai_ms_total: result.ask_perf.openai_ms_total,
            fs_bytes_total: result.ask_perf.fs_bytes_total,
            fs_read_ms_total: result.ask_perf.fs_read_ms_total,
            fs_parse_ms_total: result.ask_perf.fs_parse_ms_total,
            index_loaded_from_disk: result.ask_perf.index_loaded_from_disk,
            index_rebuilt: result.ask_perf.index_rebuilt,
            lexical_corpus_cache_hit: result.ask_perf.lexical_corpus_cache_hit,
            fs_read_count: result.ask_perf.fs_reads.length,
            notes: result.ask_perf.notes.slice(0, 20),
          }),
        );
      }

      const httpStatus =
        result.status === "error" && result.message?.includes("OPENAI")
          ? 503
          : 200;

      const headers: Record<string, string> = {};
      if (result.ask_perf) {
        headers["Server-Timing"] = formatServerTiming(result.ask_perf);
        headers["x-ask-perf-cold-or-warm"] = result.ask_perf.cold_or_warm;
        headers["x-ask-perf-total-ms"] = String(result.ask_perf.total_ms);
      }

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
          searchBudget: result.search_budget,
          askPerf: result.ask_perf,
          knowledgeExpansion: result.knowledge_expansion
            ? {
                enabled: result.knowledge_expansion.enabled,
                ran: result.knowledge_expansion.ran,
                budget: result.knowledge_expansion.budget,
                candidatesTotal: result.knowledge_expansion.candidates_total,
                alreadyCached: result.knowledge_expansion.already_cached,
                analyzedNew: result.knowledge_expansion.analyzed_new,
                analyzedSourceKeys:
                  result.knowledge_expansion.analyzed_source_keys,
                deferredSourceKeys:
                  result.knowledge_expansion.deferred_source_keys,
                failed: result.knowledge_expansion.failed.map((f) => ({
                  sourceKey: f.source_key,
                  error: f.error,
                })),
                durationMs: result.knowledge_expansion.duration_ms,
                reRanAnswer: result.knowledge_expansion.re_ran_answer,
                layers: {
                  preexisting: result.knowledge_expansion.layers.preexisting,
                  newlyAnalyzed:
                    result.knowledge_expansion.layers.newly_analyzed,
                  stillOpen: result.knowledge_expansion.layers.still_open,
                },
                notes: result.knowledge_expansion.notes,
              }
            : null,
          fullAnalysisResearch: result.full_analysis_research,
        },
        { status: httpStatus, headers },
      );
    },
  );
}
