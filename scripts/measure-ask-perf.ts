/**
 * Cold + warm askPerf measurement for identical ZECD questions.
 * Does not go through Next.js HTTP (no route compile) — measures answerQuestion path.
 *
 *   npx tsx scripts/measure-ask-perf.ts
 */
import { mkdirSync, writeFileSync } from "fs";
import { resolve } from "path";
import { loadEnvFile } from "../src/lib/core/loadEnv";
import { getLocalDataRoot } from "../src/lib/localData/root";
import { fileProjectRepository } from "../src/lib/localAuth/projectRepository";
import {
  answerQuestion,
  finalizeAskPerfOnResult,
} from "../src/lib/knowledge/answerQuestion";
import {
  askPerfMark,
  askPerfNote,
  resetAskPerfWarmState,
  runWithAskPerf,
} from "../src/lib/knowledge/askPerf";
import { clearLexicalCorpusCache } from "../src/lib/search/lexical/corpusCache";
import { clearProjectKnowledgeCache } from "../src/lib/knowledge/projectKnowledgeCache";
import { clearPortableIndexCache } from "../src/lib/portableIndex/indexLoader";

const QUESTION = "Was wissen wir über ZECD?";

async function runOnce(label: "cold" | "warm") {
  return runWithAskPerf(
    {
      question: QUESTION,
      forceCold: label === "cold",
    },
    async () => {
      askPerfMark("api_route_entered");
      askPerfNote(`measure_script=${label}; NODE_ENV=${process.env.NODE_ENV}`);
      const projects = await fileProjectRepository.list();
      const project = projects[0];
      if (!project) throw new Error("Kein Projekt");
      const raw = await answerQuestion({
        projectId: project.id,
        project,
        question: QUESTION,
        searchMode: "direct_rag",
      });
      askPerfMark("api_response_sent");
      return finalizeAskPerfOnResult(raw);
    },
  );
}

function summarize(result: Awaited<ReturnType<typeof runOnce>>) {
  const p = result.ask_perf;
  if (!p) return { error: "no ask_perf" };
  const phaseMap: Record<string, number> = {};
  for (const ph of p.phases) {
    phaseMap[ph.name] = (phaseMap[ph.name] ?? 0) + ph.duration_ms;
  }
  const topFs = [...p.fs_reads]
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, 15)
    .map((r) => ({
      kind: r.kind,
      bytes: r.bytes,
      read_ms: r.read_ms,
      parse_ms: r.parse_ms,
      path: r.path.replace(/.*\/customers\//, "…/"),
    }));
  return {
    cold_or_warm: p.cold_or_warm,
    status: result.status,
    total_ms: p.total_ms,
    duration_ms: result.duration_ms,
    local_ms_before_openai: Math.round(
      (p.total_ms - p.openai_ms_total) * 10,
    ) / 10,
    phases_summed: phaseMap,
    phases: p.phases,
    marks: p.marks,
    openai_calls: p.openai_calls,
    openai_ms_total: p.openai_ms_total,
    fs_bytes_total: p.fs_bytes_total,
    fs_read_ms_total: p.fs_read_ms_total,
    fs_parse_ms_total: p.fs_parse_ms_total,
    fs_read_count: p.fs_reads.length,
    fs_reads_non_cache: p.fs_reads.filter((r) => !r.cache_hit).length,
    index_loaded_from_disk: p.index_loaded_from_disk,
    index_rebuilt: p.index_rebuilt,
    lexical_corpus_cache_hit: p.lexical_corpus_cache_hit,
    top_fs_reads: topFs,
    notes: p.notes,
    node_env: p.node_env,
    search_budget: result.search_budget,
  };
}

async function main() {
  loadEnvFile(resolve(process.cwd(), ".env.local"));
  getLocalDataRoot();

  clearLexicalCorpusCache();
  clearProjectKnowledgeCache();
  clearPortableIndexCache();
  resetAskPerfWarmState();
  console.log("=== COLD ===");
  const cold = await runOnce("cold");
  const coldSummary = summarize(cold);

  console.log("=== WARM ===");
  const warm = await runOnce("warm");
  const warmSummary = summarize(warm);

  const report = {
    question: QUESTION,
    measured_at: new Date().toISOString(),
    note:
      "CLI path = answerQuestion (same service as /api/app/ask). Excludes Next.js route compile / RSC \"Rendering...\".",
    cold: coldSummary,
    warm: warmSummary,
  };

  const outDir = resolve(process.cwd(), "tmp/regression");
  mkdirSync(outDir, { recursive: true });
  const outPath = resolve(outDir, "ask-perf-zecd-cold-warm.json");
  writeFileSync(outPath, JSON.stringify(report, null, 2), "utf8");
  console.log(JSON.stringify(report, null, 2));
  console.log(`\nWrote ${outPath}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
