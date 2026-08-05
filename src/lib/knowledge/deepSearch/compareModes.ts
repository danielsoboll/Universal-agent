/**
 * Compare Direct Search vs KI-Tiefensuche on the same question.
 */
import { ensureWritableDir, writeGeneratedText } from "@/lib/localData/fs";
import type { ModeComparison, ModeRunMetrics } from "@/lib/knowledge/deepSearch/types";
import { runDeepSearch } from "@/lib/knowledge/deepSearch/runDeepSearch";
import { answerQuestion } from "@/lib/knowledge/answerQuestion";
import type { AnswerQuestionResult } from "@/lib/knowledge/answerQuestion";
import type { LocalProject } from "@/lib/localAuth/types";
import { resolveProjectCapabilities } from "@/lib/domain/capabilities";

function fromDirectAnswer(result: AnswerQuestionResult): ModeRunMetrics {
  const sourceTypes = [
    ...new Set(result.sources.map((s) => s.knowledge_unit_type).filter(Boolean)),
  ];
  return {
    run_id: result.planned_run_id ?? `direct_${result.duration_ms}`,
    runtime_ms: result.duration_ms,
    evidence_count: result.sources.length,
    source_types: sourceTypes,
    coverage: {
      retrieval_mode: result.retrieval_mode,
      top_score: result.top_score ?? 0,
    },
    cost: result.estimated_cost,
    query_count: result.subquery_count || 1,
    documents_searched: result.searched_document_count,
    tokens: result.token_usage,
    status: result.status,
  };
}

export async function compareDirectAndDeepSearch(params: {
  project: LocalProject;
  question: string;
  persist?: boolean;
}): Promise<{
  comparison: ModeComparison;
  direct: AnswerQuestionResult;
  deep: Awaited<ReturnType<typeof runDeepSearch>>;
}> {
  const question = params.question.trim();
  const capabilities = resolveProjectCapabilities(params.project);

  const direct = await answerQuestion({
    projectId: params.project.id,
    project: params.project,
    question,
    searchMode: "direct_rag",
  });

  const deep = await runDeepSearch({
    projectId: params.project.id,
    project: params.project,
    question,
    started: Date.now(),
    domainMeta: {
      domain_profile_id: capabilities.domainProfileId,
      prompt_key: capabilities.answerPrompt.key,
      prompt_version: capabilities.answerPrompt.version,
      search_profile_id: capabilities.searchProfile.id,
      workflow_template_id: capabilities.workflowTemplateId,
    },
  });

  const comparison: ModeComparison = {
    question,
    direct_search: fromDirectAnswer(direct),
    deep_search: deep.metrics,
  };

  if (params.persist !== false) {
    const rel = `search-runs/compare_${Date.now()}`;
    ensureWritableDir(params.project.customer_id, "logs", rel);
    writeGeneratedText(
      params.project.customer_id,
      "logs",
      `${rel}/mode-comparison.json`,
      `${JSON.stringify(comparison, null, 2)}\n`,
    );
    writeGeneratedText(
      params.project.customer_id,
      "logs",
      `${rel}/direct-answer-preview.json`,
      `${JSON.stringify(
        {
          status: direct.status,
          direct_answer: direct.direct_answer.slice(0, 2000),
          sources: direct.sources.slice(0, 8).map((s) => s.title),
        },
        null,
        2,
      )}\n`,
    );
    writeGeneratedText(
      params.project.customer_id,
      "logs",
      `${rel}/deep-answer-preview.json`,
      `${JSON.stringify(
        {
          status: deep.answer.status,
          intent: deep.query_understanding.intent,
          preferred_plan: deep.query_understanding.preferred_search_plan,
          direct_answer: deep.answer.direct_answer.slice(0, 2000),
          sources: deep.answer.sources.slice(0, 8).map((s) => s.title),
          query_understanding: deep.query_understanding,
        },
        null,
        2,
      )}\n`,
    );
  }

  return { comparison, direct, deep };
}
