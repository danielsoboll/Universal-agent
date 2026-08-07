/**
 * Map Multi-Source run → AnswerQuestionResult (App/CLI).
 * Canonical Exact-Symbol path — not dependent on Hybrid docs for programs/FMs.
 */
import type { AnswerQuestionResult } from "@/lib/knowledge/answerQuestion";
import {
  EMPTY_COMPACT_TECHNICAL_DETAILS,
  EMPTY_PROCESS_ANSWER,
  EMPTY_TECHNICAL_ANSWER,
  EMPTY_TECHNICAL_DETAILS,
} from "@/lib/knowledge/answerSchema";
import type { KnowledgeHit } from "@/lib/knowledge/types";
import type { SearchMode } from "@/lib/knowledge/queryPlanSchema";
import type { MultiSourceRunResult } from "@/lib/knowledge/multiSourceSearch/types";
import type { LocalProject } from "@/lib/localAuth/types";
import type { DomainProfileId } from "@/lib/domain/types";

function evidenceToHit(
  item: MultiSourceRunResult["evidence"]["items"][number],
  rank: number,
): KnowledgeHit {
  return {
    rank,
    search_document_id: item.id,
    source_key: item.id,
    title: item.title,
    knowledge_unit_type:
      item.source === "master_data"
        ? "master_field"
        : item.source === "control_tables"
          ? "table_profile"
          : "code_unit",
    combined_score: item.score ?? item.confidence * 100,
    exact_score: item.rank_tier === "exact" ? 10 : 0,
    fulltext_score: 0,
    vector_score: 0,
    metadata_score: 0,
    confidence_bonus: 0,
    confidence: item.confidence,
    matched_terms: item.anchors_matched,
    snippet: item.summary.slice(0, 400),
    evidence_refs: item.path_hint ? [item.path_hint] : [],
    facts: [
      item.summary,
      ...(item.tables_read?.length
        ? [`tables_read: ${item.tables_read.join(", ")}`]
        : []),
      ...(item.called_functions?.length
        ? [`calls: ${item.called_functions.join(", ")}`]
        : []),
    ],
    inferences: [],
    metadata: {
      multi_source: true,
      evidence_type: item.evidence_type,
      path_hint: item.path_hint,
    },
    object_name: item.object_name ?? item.table_name ?? "",
    object_type: item.object_type ?? item.source,
    subobject_name: item.field_name ?? "",
    technical_summary: item.summary.slice(0, 500),
    business_purpose: "",
    tables_read: item.tables_read ?? [],
    tables_written: item.tables_written ?? [],
    called_methods: item.called_methods ?? [],
    called_functions: item.called_functions ?? [],
    hardcoded_values: item.evidence_lines ?? [],
    entities: [],
    relations: [],
    evidence: (item.evidence_lines ?? []).map((t) => ({
      statement_type: "fact" as const,
      text: t,
      lines: [] as { line?: number; quote?: string }[],
    })),
    doc_confidence: item.confidence,
  };
}

function stmt(text: string, ranks: number[] = [1]) {
  return {
    text,
    level: "confirmed" as const,
    source_ranks: ranks,
    source_ids: [] as string[],
  };
}

export function mapMultiSourceToAnswerResult(params: {
  run: MultiSourceRunResult;
  project: LocalProject;
  requestedMode: SearchMode;
  started: number;
  domainMeta: {
    domain_profile_id: string;
    prompt_key: string;
    prompt_version: string;
    search_profile_id: string;
    workflow_template_id: string | null;
  };
}): AnswerQuestionResult {
  const { run, project, requestedMode, started, domainMeta } = params;
  const sources = run.evidence.items
    .slice(0, 16)
    .map((item, i) => evidenceToHit(item, i + 1));

  const objects = (
    run.specialized_plan.primary_anchor?.objects ??
    run.evidence.items
      .filter((i) => i.source === "exact_symbol")
      .map((i) => i.object_name)
      .filter((x): x is string => Boolean(x))
  ).slice(0, 20);

  const symbol =
    run.specialized_plan.primary_anchor?.symbol ??
    (run.search_trace.extracted_tokens ?? [])[0] ??
    "";

  const direct =
    run.answer?.direct_answer ??
    (objects.length
      ? `Technische Objekte mit ${symbol || "Symbol"}: ${objects.slice(0, 8).join(", ")}`
      : "Keine ausreichende Multi-Source-Evidenz.");

  const status: AnswerQuestionResult["status"] =
    run.status === "error"
      ? "error"
      : run.status === "insufficient" || sources.length === 0
        ? "insufficient"
        : "ok";

  const objectStmts = objects.map((o, i) => stmt(o, [i + 1]));

  return {
    status,
    question: run.question,
    direct_answer: direct,
    reasoning: run.answer?.reasoning ?? "Multi-Source Exact-Symbol-Pipeline",
    technical_objects: objects,
    uncertainties: run.answer?.open_questions ?? [],
    process_answer: {
      ...EMPTY_PROCESS_ANSWER,
      direct_answer: direct,
      special_process: symbol
        ? `Exact-Symbol ${symbol}`
        : run.specialized_plan.plan_type,
      trigger: symbol,
      process_effect: objects.slice(0, 6).join(", "),
      business_interpretation: direct.slice(0, 800),
      open_validation_questions: run.answer?.open_questions ?? [],
      confirmed: objectStmts,
      has_safe_process_claim: objects.length > 0,
    },
    technical_answer: {
      ...EMPTY_TECHNICAL_ANSWER,
      entry_point: objects[0] ? [stmt(objects[0]!)] : [],
      trigger: symbol ? [stmt(`Exact-Symbol ${symbol}`)] : [],
      processing: [stmt(direct.slice(0, 600))],
      objects: objectStmts,
      open: (run.answer?.open_questions ?? []).map((t) => ({
        text: t,
        level: "possible" as const,
        source_ranks: [] as number[],
        source_ids: [] as string[],
      })),
    },
    technical_details: {
      ...EMPTY_TECHNICAL_DETAILS,
      sources: sources.map((s) => ({
        object_kind: s.object_type,
        class_or_program: s.object_name,
        method_or_routine: s.subobject_name,
        source_key: s.source_key,
        title: s.title,
        knowledge_unit_type: s.knowledge_unit_type,
        rank: s.rank,
        score: s.combined_score,
      })),
      called_objects: [
        ...new Set(sources.flatMap((s) => s.called_functions)),
      ].slice(0, 20),
      table_accesses: [
        ...new Set(
          sources.flatMap((s) => [...s.tables_read, ...s.tables_written]),
        ),
      ].slice(0, 20),
      facts: sources.flatMap((s) => s.facts).slice(0, 20),
      retrieval_scores: sources.map((s) => ({
        rank: s.rank,
        title: s.title,
        combined: s.combined_score,
        exact: s.exact_score,
      })),
    },
    compact_technical_details: {
      ...EMPTY_COMPACT_TECHNICAL_DETAILS,
      quelle: sources.slice(0, 5).map((s) => s.title),
      ausloeser: symbol ? [symbol] : [],
      systemaktion: [direct.slice(0, 300)],
      beleg: objects.slice(0, 5),
      unsicherheit: run.answer?.open_questions?.slice(0, 3) ?? [],
    },
    question_intent: "technical_symbol",
    evidence_context_report: {
      input_hit_count: run.evidence.items.length,
      detailed_count: sources.length,
      compact_count: 0,
      omitted_count: run.evidence.omitted,
      previously_weak_fields_now_included: [],
      notes: [
        `multi_source plan=${run.specialized_plan.plan_type}`,
        `log_dir=${run.log_dir}`,
        `extracted_tokens=${(run.search_trace.extracted_tokens ?? []).join(",")}`,
        ...run.evidence.ranking_notes.slice(0, 6),
      ],
    },
    entity_grounding: [],
    relevance_gate: null,
    sources,
    model: run.answer?.model ?? "multi_source",
    token_usage: {
      input: run.metrics.synthesis_tokens?.input ?? 0,
      output: run.metrics.synthesis_tokens?.output ?? 0,
      embedding: 0,
    },
    estimated_cost: 0,
    retrieval_summary: `Multi-Source Exact-Symbol (${run.specialized_plan.plan_type}); Evidenz=${run.evidence.items.length}`,
    retrieval_mode: "multi_source_canonical",
    searched_document_count: run.evidence.items.length,
    top_score: sources[0]?.combined_score ?? null,
    index_path: project.active_index_path,
    vector_search_active: false,
    warnings: [
      "Exact-Symbol-Pfad: Canonical Multi-Source (Programme/FuBas nicht an Hybrid gebunden).",
    ],
    message: run.message,
    search_mode: requestedMode,
    requested_search_mode: requestedMode,
    query_plan: null,
    subquery_count: run.stages.length,
    planner_fallback: false,
    duration_ms: Date.now() - started,
    domain_profile_id: domainMeta.domain_profile_id as DomainProfileId,
    prompt_key: domainMeta.prompt_key,
    prompt_version: domainMeta.prompt_version,
    search_profile_id: domainMeta.search_profile_id,
    workflow_template_id: domainMeta.workflow_template_id,
    conversation_mode: false,
    planned_run_id: run.run_id,
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
}
