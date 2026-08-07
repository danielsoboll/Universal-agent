/**
 * Live diagnose for HARDCODED_VALUE_INVENTORY material question.
 */
import { resolve } from "path";
import { writeFileSync } from "fs";
import { loadEnvFile } from "../src/lib/core/loadEnv";
import { getLocalDataRoot } from "../src/lib/localData/root";
import { fileProjectRepository } from "../src/lib/localAuth/projectRepository";
import { answerQuestion } from "../src/lib/knowledge/answerQuestion";

async function main() {
  loadEnvFile(resolve(process.cwd(), ".env.local"));
  getLocalDataRoot();

  const projects = await fileProjectRepository.list();
  const projectId = projects[0]?.id;
  if (!projectId) {
    console.error("Kein Projekt gefunden");
    process.exit(2);
  }

  const q =
    "Welche Materialnummern sind hart codiert und welche Geschäftsprozesse werden damit gesteuert?";

  const result = await answerQuestion({
    projectId,
    question: q,
    searchMode: "direct_rag",
  });
  const orch = result.ask_orchestration;
  const hc = orch?.hardcoded_value ?? null;
  const view = result.hardcoded_value_answer;

  const report = {
    status: result.status,
    intent: orch?.intent ?? result.question_intent,
    enrichment: hc?.enrichment ?? null,
    summary: view?.summary?.text ?? null,
    unique_count: view?.summary?.unique_material_count ?? 0,
    top8:
      view?.materials.slice(0, 8).map((m) => ({
        material_number: m.material_number,
        occurrence_count: m.occurrence_count,
        process_label: m.process_label,
        condition: m.condition_summary,
        effect: m.effect_summary,
        evidence_status: m.evidence_status,
      })) ?? [],
    missing_information: view?.missing_information ?? [],
    duration_ms: result.duration_ms,
    diagnostics: {
      units_scanned: hc?.units_scanned,
      accepted: hc?.accepted_candidates,
      unique: hc?.unique_materials?.length,
      mara_hits: hc?.enrichment?.mara_hits,
      analysis_hit_units: hc?.enrichment?.analysis_hit_units,
      validated_accepted: hc?.enrichment?.validated_accepted,
      validated_rejected: hc?.enrichment?.validated_rejected,
    },
  };

  const out = resolve(
    process.cwd(),
    "tmp/regression/hardcoded-material-enriched.json",
  );
  writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  console.error(`wrote ${out}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
