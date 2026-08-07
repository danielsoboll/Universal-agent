/**
 * Regression after ask-pipeline restore (direct_rag hybrid + relevance gate).
 * Uses the same answerQuestion path as POST /api/app/ask.
 *
 *   npx tsx scripts/regression-ask-restore.ts
 */
import { resolve } from "path";
import { writeFileSync } from "fs";
import { loadEnvFile } from "../src/lib/core/loadEnv";
import { getLocalDataRoot } from "../src/lib/localData/root";
import { fileProjectRepository } from "../src/lib/localAuth/projectRepository";
import { answerQuestion } from "../src/lib/knowledge/answerQuestion";

const CASES = [
  { id: "EDIOCTOPUS", question: "EDIOCTOPUS" },
  { id: "ZECD", question: "Was wissen wir über die Nachricht ZECD?" },
  { id: "ZRAH", question: "ZRAH" },
  {
    id: "VLAGER",
    question: "Wie funktioniert das Edeka virtuelle Lager?",
  },
] as const;

async function main() {
  loadEnvFile(resolve(process.cwd(), ".env.local"));
  getLocalDataRoot();
  const projects = await fileProjectRepository.list();
  const projectId = projects[0]?.id;
  if (!projectId) {
    console.error("Kein Projekt");
    process.exit(2);
  }

  const report: Record<string, unknown>[] = [];

  for (const c of CASES) {
    const started = Date.now();
    const result = await answerQuestion({
      projectId,
      question: c.question,
      searchMode: "direct_rag",
    });
    const unsupported = [
      ...(result.relevance_gate?.similar_but_insufficient_source_ids ?? []),
      ...(result.uncertainties ?? []),
      ...(result.warnings ?? []),
    ].filter(
      (x) =>
        /verworfen|nicht ausreichend|ungrounded|keine belastbaren/i.test(x),
    );

    report.push({
      id: c.id,
      question: c.question,
      status: result.status,
      intent: result.question_intent,
      retrieval_mode: result.retrieval_mode,
      retrieval_summary: result.retrieval_summary,
      hit_count: result.sources.length,
      sources: result.sources.slice(0, 8).map((s) => ({
        rank: s.rank,
        title: s.title,
        source_key: s.source_key,
        score: s.combined_score,
      })),
      direct_answer: result.direct_answer?.slice(0, 400),
      relevance: result.relevance_gate
        ? {
            answerability: result.relevance_gate.answerability,
            reason: result.relevance_gate.reason,
            missing: result.relevance_gate.missing_concepts,
          }
        : null,
      entity_grounding: (result.entity_grounding ?? []).map((g) => ({
        entity: g.query_entity,
        status: g.grounding_status,
        reason: g.reason,
      })),
      compact_tech: result.compact_technical_details,
      table_field_count:
        (result.compact_technical_details?.ausloeser?.length ?? 0) +
        (result.compact_technical_details?.systemaktion?.length ?? 0) +
        (result.technical_details?.table_accesses?.length ?? 0),
      unsupported_notes: unsupported.slice(0, 6),
    search_budget: result.search_budget
      ? {
          stage: result.search_budget.stage_reached,
          named_entity: result.search_budget.named_entity,
          anchors: result.search_budget.technical_anchors,
          cache_hits: result.search_budget.cache_hits,
          openai_calls: result.search_budget.new_openai_calls,
          estimated_input_tokens: result.search_budget.estimated_input_tokens,
          escalation: result.search_budget.escalation_reason,
          blocked: result.search_budget.blocked_reason,
          on_demand_executed: result.search_budget.on_demand_executed,
        }
      : null,
    duration_ms: Date.now() - started,
  });
    console.log(`\n=== ${c.id} ===`);
    console.log(JSON.stringify(report[report.length - 1], null, 2));
  }

  const out = resolve(process.cwd(), "tmp/regression/ask-restore-report.json");
  writeFileSync(out, JSON.stringify(report, null, 2));
  console.error(`\nwrote ${out}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
