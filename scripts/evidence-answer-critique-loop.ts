/**
 * Iterativer OpenAI-Quercheck: Evidence-Paket vs. Antwort.
 *
 *   npx tsx scripts/evidence-answer-critique-loop.ts
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
  question: string;
  evidence_prompt: string;
  answer: string;
  reasoning: string;
  sources: Array<{ rank: number; type: string; key: string; title: string }>;
}) {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const completion = await client.chat.completions.create({
    model: AI_CONFIG.chatModel,
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: `Du bist ein strenger RAG-Auditor. Prüfe Faithfulness und Nutzen NUR gegen das Evidence-Paket.
Wichtige Regel: Fehlende Fachhandbücher/Org-Konzepte, die NICHT im Evidence stehen, senken process_coverage NICHT — bewerte nur, ob der aus dem Paket ableitbare technische Prozess (Feld → Steuerung → Codewirkungen) klar und vollständig wiedergegeben wurde.
Antwort auf Deutsch als JSON:
{
  "score_faithfulness": 0-10,
  "score_usefulness": 0-10,
  "score_process_coverage": 0-10,
  "hallucinations": ["..."],
  "unused_strong_evidence": ["was in Evidence stark ist, aber Antwort ignoriert"],
  "missing_in_evidence": ["echte Lücken im Paket, nicht Wunschdenken nach Handbüchern"],
  "evidence_quality_issues": ["..."],
  "concrete_retrieval_fixes": ["generische Retrieval/Evidence-Fixes"],
  "verdict": "pass|iterate|fail",
  "one_line": "Kurzfazit"
}
verdict=pass wenn faithfulness>=8 und usefulness>=7 und process_coverage>=7 und keine Halluzinationen.`,
      },
      {
        role: "user",
        content: JSON.stringify(
          {
            question: params.question,
            sources: params.sources,
            evidence_prompt: params.evidence_prompt.slice(0, 14000),
            answer: params.answer,
            reasoning: params.reasoning,
          },
          null,
          2,
        ),
      },
    ],
  });
  const text = completion.choices[0]?.message?.content ?? "{}";
  return {
    critique: JSON.parse(text) as Record<string, unknown>,
    tokens: {
      input: completion.usage?.prompt_tokens ?? 0,
      output: completion.usage?.completion_tokens ?? 0,
    },
  };
}

async function main() {
  const projects = await fileProjectRepository.list();
  const project =
    projects.find((p) => p.customer_id === "P01") ?? projects[0];
  if (!project) throw new Error("Kein Projekt");

  const outDir = resolve(process.cwd(), "tmp/regression");
  mkdirSync(outDir, { recursive: true });

  // --- Retrieval + Evidence (was OpenAI wirklich sieht) ---
  const kr = await KnowledgeRetriever.search({
    project,
    query: QUESTION,
    limit: 12,
  });
  const intent = classifyQuestionIntent(QUESTION);
  const evidence = buildEvidenceContext({
    hits: kr.hits,
    intent,
    groundingResults: [],
    question: QUESTION,
    coverage: "normal",
  });

  writeFileSync(
    resolve(outDir, "edeka-vl-evidence-prompt.txt"),
    evidence.prompt_text,
    "utf8",
  );
  writeFileSync(
    resolve(outDir, "edeka-vl-retrieval.json"),
    JSON.stringify(
      {
        warnings: kr.warnings,
        primary: kr.lexical_diagnosis?.selected_primary_anchors,
        expansion_tokens: kr.lexical_expansion_tokens,
        hits: kr.hits.map((h) => ({
          rank: h.rank,
          score: h.combined_score,
          type: h.knowledge_unit_type,
          key: h.source_key,
          title: h.title,
          purpose: h.business_purpose,
          matched: h.matched_terms?.slice(0, 8),
          snippet: (h.snippet || "").slice(0, 200),
          facts: (h.facts || []).slice(0, 8),
        })),
        truncation: evidence.truncation_report,
      },
      null,
      2,
    ),
    "utf8",
  );

  // --- Echte App-Antwort ---
  const answer = await answerQuestion({
    projectId: project.id,
    question: QUESTION,
    searchMode: "direct_rag",
  });

  const critiqueResult = await critique({
    question: QUESTION,
    evidence_prompt: evidence.prompt_text,
    answer: answer.direct_answer,
    reasoning: answer.reasoning,
    sources: answer.sources.map((s) => ({
      rank: s.rank,
      type: s.knowledge_unit_type,
      key: s.source_key,
      title: s.title,
    })),
  });

  const report = {
    question: QUESTION,
    retrieval_mode: answer.retrieval_mode,
    duration_ms: answer.duration_ms,
    warnings: answer.warnings,
    top_hits: kr.hits.slice(0, 8).map((h) => ({
      rank: h.rank,
      type: h.knowledge_unit_type,
      key: h.source_key,
      score: h.combined_score,
    })),
    direct_answer: answer.direct_answer,
    reasoning: answer.reasoning,
    process_answer: {
      trigger: answer.process_answer.trigger,
      process_effect: answer.process_answer.process_effect,
      special_process: answer.process_answer.special_process,
      confirmed: answer.process_answer.confirmed?.slice(0, 5),
      open: answer.process_answer.open?.slice(0, 5),
    },
    technical_answer: answer.technical_answer,
    evidence_truncation: answer.evidence_context_report,
    openai_critique: critiqueResult.critique,
    critique_tokens: critiqueResult.tokens,
  };

  writeFileSync(
    resolve(outDir, "edeka-vl-critique-round6.json"),
    JSON.stringify(report, null, 2),
    "utf8",
  );

  console.log(JSON.stringify(report, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
