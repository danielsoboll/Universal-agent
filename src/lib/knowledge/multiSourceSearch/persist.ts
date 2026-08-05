/**
 * Persist multi-source search runs under logs/search-runs/<run-id>/.
 * Writes only to logs/ — never touches raw/canonical/embeddings/indexes.
 */
import { ensureWritableDir, writeGeneratedText } from "@/lib/localData/fs";
import type { MultiSourceRunResult } from "@/lib/knowledge/multiSourceSearch/types";

export function persistMultiSourceRun(
  result: MultiSourceRunResult,
): { log_dir: string; files: string[] } {
  const relBase = `search-runs/${result.run_id}`;
  ensureWritableDir(result.project_key, "logs", relBase);

  const files: string[] = [];
  const write = (name: string, data: unknown) => {
    const content =
      typeof data === "string" ? data : JSON.stringify(data, null, 2);
    writeGeneratedText(
      result.project_key,
      "logs",
      `${relBase}/${name}`,
      content.endsWith("\n") ? content : `${content}\n`,
    );
    files.push(name);
  };

  write("plan.json", result.plan);
  write("specialized-plan.json", result.specialized_plan);
  write("primary-anchor.json", result.specialized_plan.primary_anchor);
  write("search-trace.json", result.search_trace);
  write("structured-context.json", result.structured_context);
  write(
    "queries.json",
    result.stages.map((s) => ({
      stage: s.stage,
      round: s.round,
      queries: s.queries,
      duration_ms: s.duration_ms,
    })),
  );
  write("anchors.json", result.anchors);
  write("evidence.json", result.evidence);
  write("relations.json", result.relations);
  write("coverage.json", result.coverage);
  write("stages.json", result.stages);
  write("final-context.txt", result.final_context);
  write("answer.json", result.answer);
  write("metrics.json", result.metrics);
  write("summary.json", {
    run_id: result.run_id,
    status: result.status,
    question: result.question,
    message: result.message,
    plan_type: result.specialized_plan.plan_type,
    primary_anchor: result.specialized_plan.primary_anchor,
    evidence_by_source: result.evidence.by_source,
    anchors: result.anchors.length,
    search_trace_steps: result.search_trace.steps_completed,
    log_dir: `logs/${relBase}`,
  });

  return { log_dir: `logs/${relBase}`, files };
}
