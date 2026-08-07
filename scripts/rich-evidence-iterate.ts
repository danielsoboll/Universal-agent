/**
 * Rich evidence iteration: measure input size/quality vs OpenAI critique.
 *
 *   npx tsx scripts/rich-evidence-iterate.ts
 */
import { resolve } from "path";
import { writeFileSync, mkdirSync } from "fs";
import OpenAI from "openai";
import { loadEnvFile } from "../src/lib/core/loadEnv";
import { getLocalDataRoot } from "../src/lib/localData/root";
import { fileProjectRepository } from "../src/lib/localAuth/projectRepository";
import { answerQuestion } from "../src/lib/knowledge/answerQuestion";
import { KnowledgeRetriever } from "../src/lib/knowledge/knowledgeRetriever";
import { buildEvidenceContext } from "../src/lib/knowledge/evidenceContext";
import { classifyQuestionIntent } from "../src/lib/knowledge/questionIntent";
import { AI_CONFIG } from "../src/lib/ai/config";

const QUESTION = "Wie funktioniert das Edeka virtuelle Lager?";

loadEnvFile(resolve(process.cwd(), ".env.local"));
getLocalDataRoot();

async function critique(params: {
  evidence_chars: number;
  evidence_prompt: string;
  answer: string;
  reasoning: string;
  process: unknown;
}) {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const completion = await client.chat.completions.create({
    model: AI_CONFIG.chatModel,
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: `Strenger RAG-Auditor. Bewerte nur gegen das Evidence-Paket.
Regel: Fehlende Handbücher außerhalb des Pakets senken process_coverage NICHT.
JSON Deutsch:
{
  "score_faithfulness":0-10,
  "score_usefulness":0-10,
  "score_process_coverage":0-10,
  "score_specificity":0-10,
  "hallucinations":[],
  "unused_strong_evidence":[],
  "missing_in_evidence":[],
  "input_quality":0-10,
  "verdict":"pass|iterate|fail",
  "one_line":"...",
  "what_to_add_to_input_next":["konkrete Evidence-Bausteine"]
}
pass wenn F>=8 U>=8 P>=8 specificity>=7 und keine Halluzinationen.`,
      },
      {
        role: "user",
        content: JSON.stringify(
          {
            question: QUESTION,
            evidence_chars: params.evidence_chars,
            evidence_prompt: params.evidence_prompt.slice(0, 28000),
            answer: params.answer,
            reasoning: params.reasoning,
            process: params.process,
          },
          null,
          2,
        ),
      },
    ],
  });
  return JSON.parse(completion.choices[0]?.message?.content ?? "{}");
}

async function main() {
  const projects = await fileProjectRepository.list();
  const project =
    projects.find((p) => p.customer_id === "P01") ?? projects[0];
  if (!project) throw new Error("Kein Projekt");
  const outDir = resolve(process.cwd(), "tmp/regression");
  mkdirSync(outDir, { recursive: true });

  const kr = await KnowledgeRetriever.search({
    project,
    query: QUESTION,
    limit: 40,
  });
  const intent = classifyQuestionIntent(QUESTION);
  const evidence = buildEvidenceContext({
    hits: kr.hits,
    intent,
    groundingResults: [],
    question: QUESTION,
    coverage: "normal",
  });

  const inputStats = {
    hit_count: kr.hits.length,
    evidence_chars: evidence.prompt_text.length,
    detailed: evidence.truncation_report.detailed_count,
    compact: evidence.truncation_report.compact_count,
    code_hits: kr.hits.filter((h) => h.knowledge_unit_type === "code_unit").length,
    master_fields: kr.hits.filter((h) => h.knowledge_unit_type === "master_field")
      .length,
    profiles: kr.hits.filter((h) => h.knowledge_unit_type === "table_profile")
      .length,
    rows: kr.hits.filter((h) => h.knowledge_unit_type === "table_row").length,
    process_class_methods: kr.hits.filter((h) =>
      /VIRTUELL|VLAGER/i.test(h.object_name + h.subobject_name),
    ).length,
    warnings: kr.warnings,
    top: kr.hits.slice(0, 15).map((h) => ({
      rank: h.rank,
      type: h.knowledge_unit_type,
      key: h.source_key,
      title: h.title,
    })),
  };

  writeFileSync(
    resolve(outDir, "edeka-vl-rich-evidence.txt"),
    evidence.prompt_text,
    "utf8",
  );

  const answer = await answerQuestion({
    projectId: project.id,
    question: QUESTION,
    searchMode: "direct_rag",
    limit: 40,
  });

  const critiqueResult = await critique({
    evidence_chars: evidence.prompt_text.length,
    evidence_prompt: evidence.prompt_text,
    answer: answer.direct_answer,
    reasoning: answer.reasoning,
    process: {
      trigger: answer.process_answer.trigger,
      effect: answer.process_answer.process_effect,
      special: answer.process_answer.special_process,
      confirmed: answer.process_answer.confirmed?.slice(0, 8),
    },
  });

  const report = {
    inputStats,
    evidence_context_report: answer.evidence_context_report,
    duration_ms: answer.duration_ms,
    warnings: answer.warnings,
    direct_answer: answer.direct_answer,
    reasoning: answer.reasoning,
    process_answer: {
      trigger: answer.process_answer.trigger,
      process_effect: answer.process_answer.process_effect,
      special_process: answer.process_answer.special_process,
      business_interpretation: answer.process_answer.business_interpretation,
    },
    technical_answer: answer.technical_answer,
    sources: answer.sources.slice(0, 20).map((s) => ({
      rank: s.rank,
      type: s.knowledge_unit_type,
      key: s.source_key,
      title: s.title,
    })),
    critique: critiqueResult,
  };

  writeFileSync(
    resolve(outDir, "edeka-vl-rich-round.json"),
    JSON.stringify(report, null, 2),
    "utf8",
  );
  console.log(JSON.stringify(report, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
