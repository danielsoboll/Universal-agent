/**
 * CLI — Multi-Source / Staged RAG (separate from direct_rag).
 *
 *   npm run search:multi -- --project P01 --query "..."
 *   npm run search:multi -- --project P01 --query "..." --no-synthesize
 *   npm run search:multi -- --project P01 --query "..." --compare-direct
 */
import { resolve } from "path";
import { loadEnvFile } from "../src/lib/core/loadEnv";
import { getLocalDataRoot } from "../src/lib/localData/root";
import { fileProjectRepository } from "../src/lib/localAuth/projectRepository";
import { runMultiSourceSearch } from "../src/lib/knowledge/multiSourceSearch";
import { answerQuestion } from "../src/lib/knowledge/answerQuestion";

function argValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i < 0) return undefined;
  return argv[i + 1];
}

function hasFlag(argv: string[], name: string): boolean {
  return argv.includes(name);
}

async function main() {
  loadEnvFile(resolve(process.cwd(), ".env.local"));
  getLocalDataRoot();
  const argv = process.argv.slice(2);
  const query = argValue(argv, "--query")?.trim();
  if (!query) {
    console.error("--query ist erforderlich");
    process.exit(2);
  }

  let projectId = argValue(argv, "--project")?.trim();
  if (!projectId) {
    const projects = await fileProjectRepository.list();
    projectId = projects[0]?.id;
  }
  if (!projectId) {
    console.error("Kein Projekt. npm run seed:demo-project");
    process.exit(2);
  }

  const maxRounds = Number(argValue(argv, "--max-rounds") ?? "2");
  const synthesize = !hasFlag(argv, "--no-synthesize");
  const compareDirect = hasFlag(argv, "--compare-direct");

  let compareNote: string | undefined;
  if (compareDirect) {
    console.error("[compare] direct_rag läuft parallel (unverändert)…");
    try {
      const direct = await answerQuestion({
        projectId,
        question: query,
        searchMode: "direct_rag",
        limit: 12,
      });
      const top = (direct.sources ?? [])
        .slice(0, 5)
        .map(
          (s: { title?: string; source_key?: string }, i: number) =>
            `${i + 1}. ${s.title ?? s.source_key ?? "?"}`,
        );
      compareNote = [
        `direct_rag status=${direct.status}`,
        `direct_rag sources≈${(direct.sources ?? []).length}`,
        `direct_rag top: ${top.join(" | ") || "—"}`,
        `direct_answer_preview: ${(direct.direct_answer ?? "").slice(0, 280)}`,
      ].join("\n");
    } catch (e) {
      compareNote = `direct_rag compare failed: ${e instanceof Error ? e.message : e}`;
    }
  }

  const result = await runMultiSourceSearch({
    projectId,
    question: query,
    maxRounds: Number.isFinite(maxRounds) ? maxRounds : 2,
    synthesize,
    compareNote,
  });

  const compact = {
    status: result.status,
    run_id: result.run_id,
    log_dir: result.log_dir,
    question: result.question,
    plan: {
      concepts: result.plan.concepts,
      synonym_candidates: result.plan.synonym_candidates.slice(0, 24),
      source_order: result.plan.source_order,
      max_rounds: result.plan.max_rounds,
      notes: result.plan.notes,
      plan_type: result.specialized_plan.plan_type,
    },
    primary_anchor: result.specialized_plan.primary_anchor,
    search_trace: result.search_trace,
    coverage: result.coverage.map((c) => ({
      source: c.source,
      status: c.status,
      expected_path: c.expected_path,
      record_count_estimate: c.record_count_estimate,
      diagnosis: c.diagnosis,
      searchable_via: c.searchable_via,
    })),
    stages: result.stages.map((s) => ({
      stage: s.stage,
      round: s.round,
      hit_count: s.hits.length,
      new_anchors: s.new_anchors.length,
      confidence: s.confidence,
      why_next: s.why_next,
      abort: s.abort,
      abort_reason: s.abort_reason,
      queries: s.queries,
      duration_ms: s.duration_ms,
    })),
    anchors_sample: result.anchors.slice(0, 40),
    evidence_by_source: result.evidence.by_source,
    evidence_sample: result.evidence.items.slice(0, 20).map((e) => ({
      id: e.id,
      source: e.source,
      rank_tier: e.rank_tier,
      title: e.title,
      anchors_matched: e.anchors_matched,
      confidence: e.confidence,
    })),
    answer: result.answer,
    metrics: result.metrics,
    compare_note: compareNote,
  };

  console.log(JSON.stringify(compact, null, 2));
  if (result.status === "error") process.exit(1);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
