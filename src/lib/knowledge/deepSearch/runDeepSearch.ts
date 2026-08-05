/**
 * KI-Tiefensuche orchestrator:
 * Query Understanding → Search Plan → Multi-Source → Synthesis
 * Does not alter direct_rag.
 */
import { ensureWritableDir, writeGeneratedText } from "@/lib/localData/fs";
import { runQueryUnderstanding } from "@/lib/knowledge/deepSearch/queryUnderstanding";
import { selectSearchPlan } from "@/lib/knowledge/deepSearch/selectSearchPlan";
import type {
  ModeRunMetrics,
  QueryUnderstanding,
} from "@/lib/knowledge/deepSearch/types";
import { mapMultiSourceToAnswerResult } from "@/lib/knowledge/mapMultiSourceToAnswer";
import { runMultiSourceSearch } from "@/lib/knowledge/multiSourceSearch";
import type { MultiSourceRunResult } from "@/lib/knowledge/multiSourceSearch/types";
import type { LocalProject } from "@/lib/localAuth/types";
import type { SearchMode } from "@/lib/knowledge/queryPlanSchema";

export type DeepSearchResult = {
  answer: ReturnType<typeof mapMultiSourceToAnswerResult>;
  query_understanding: QueryUnderstanding;
  multi_source: MultiSourceRunResult;
  metrics: ModeRunMetrics;
  log_dir: string;
};

function persistQueryUnderstanding(
  projectKey: string,
  runId: string,
  qu: QueryUnderstanding,
): string {
  const relBase = `search-runs/${runId}`;
  ensureWritableDir(projectKey, "logs", relBase);
  writeGeneratedText(
    projectKey,
    "logs",
    `${relBase}/query-understanding.json`,
    `${JSON.stringify(qu, null, 2)}\n`,
  );
  return `logs/${relBase}`;
}

function estimateCost(tokens: {
  input: number;
  output: number;
  embedding: number;
}): number {
  // Rough USD estimate — same ballpark as ask cost reporting
  return (
    (tokens.input / 1_000_000) * 0.15 +
    (tokens.output / 1_000_000) * 0.6 +
    (tokens.embedding / 1_000_000) * 0.02
  );
}

export function multiSourceToModeMetrics(
  run: MultiSourceRunResult,
  extraTokens?: { input: number; output: number },
): ModeRunMetrics {
  const input =
    (run.metrics.synthesis_tokens?.input ?? 0) + (extraTokens?.input ?? 0);
  const output =
    (run.metrics.synthesis_tokens?.output ?? 0) + (extraTokens?.output ?? 0);
  const tokens = { input, output, embedding: 0 };
  return {
    run_id: run.run_id,
    runtime_ms: run.metrics.duration_ms,
    evidence_count: run.evidence.items.length,
    source_types: Object.entries(run.evidence.by_source)
      .filter(([, n]) => n > 0)
      .map(([k]) => k),
    coverage: Object.fromEntries(
      run.coverage.map((c) => [c.source, c.status]),
    ),
    cost: estimateCost(tokens),
    query_count: run.stages.reduce((n, s) => n + s.queries.length, 0),
    documents_searched: run.evidence.items.length + run.evidence.omitted,
    tokens,
    status: run.status,
  };
}

export async function runDeepSearch(params: {
  projectId: string;
  question: string;
  project: LocalProject;
  started: number;
  maxRounds?: number;
  synthesize?: boolean;
  domainMeta: {
    domain_profile_id: string;
    prompt_key: string;
    prompt_version: string;
    search_profile_id: string;
    workflow_template_id: string | null;
  };
}): Promise<DeepSearchResult> {
  const question = params.question.trim();
  const qu = await runQueryUnderstanding(question);
  const selected = selectSearchPlan(qu);

  const ms = await runMultiSourceSearch({
    projectId: params.projectId,
    project: params.project,
    question,
    maxRounds: params.maxRounds ?? 2,
    synthesize: params.synthesize !== false,
    enrichPlanWithLlm: false,
    planSeeds: {
      concepts: selected.seed_concepts,
      synonyms: [
        ...selected.seed_synonyms,
        ...qu.technical_tokens,
        // business_concepts already filtered; do not re-add assumed object types
        ...qu.business_concepts,
      ],
      notes: [
        "KI-Tiefensuche / Query-Understanding",
        ...selected.notes,
        ...qu.warnings,
      ],
      soft_context: selected.soft_context,
      hypotheses_to_verify: selected.hypotheses_to_verify,
    },
  });

  const logDir = persistQueryUnderstanding(
    ms.project_key,
    ms.run_id,
    qu,
  );

  const answer = mapMultiSourceToAnswerResult({
    run: ms,
    project: params.project,
    requestedMode: "deep_search" as SearchMode,
    started: params.started,
    domainMeta: {
      ...params.domainMeta,
      prompt_key: qu.prompt_version,
      prompt_version: qu.prompt_version,
    },
  });

  // Align contract fields for mode comparison
  answer.search_mode = "deep_search";
  answer.requested_search_mode = "deep_search";
  answer.retrieval_mode = "deep_search_multi_source";
  answer.question_intent = qu.intent;
  answer.duration_ms = Date.now() - params.started;
  answer.token_usage = {
    input:
      (ms.metrics.synthesis_tokens?.input ?? 0) + qu.token_usage.input,
    output:
      (ms.metrics.synthesis_tokens?.output ?? 0) + qu.token_usage.output,
    embedding: 0,
  };
  answer.estimated_cost = estimateCost(answer.token_usage);
  answer.subquery_count = ms.stages.reduce(
    (n, s) => n + s.queries.length,
    0,
  );
  answer.warnings = [
    ...answer.warnings,
    `Query-Understanding intent=${qu.intent} plan=${qu.preferred_search_plan}`,
    `query-understanding.json → ${logDir}/query-understanding.json`,
    ...qu.warnings.slice(0, 4),
  ];
  if (answer.evidence_context_report) {
    answer.evidence_context_report.notes = [
      `intent=${qu.intent}`,
      `technical_tokens=${qu.technical_tokens.join(",")}`,
      `hypotheses=${qu.user_hypotheses.map((h) => h.status).join(",")}`,
      ...answer.evidence_context_report.notes,
    ];
  }

  const metrics = multiSourceToModeMetrics(ms, qu.token_usage);
  metrics.runtime_ms = answer.duration_ms;
  metrics.cost = answer.estimated_cost;
  metrics.tokens = answer.token_usage;

  return {
    answer,
    query_understanding: qu,
    multi_source: ms,
    metrics,
    log_dir: logDir,
  };
}
