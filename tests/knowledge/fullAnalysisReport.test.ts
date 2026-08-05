/**
 *   npx tsx tests/knowledge/fullAnalysisReport.test.ts
 */
import assert from "assert";
import {
  buildFullAnalysisMarkdown,
  markdownToDocxBuffer,
} from "../../src/lib/knowledge/fullAnalysisReport";
import { FULL_ANALYSIS_VERSION } from "../../src/lib/knowledge/executeFullAnalysis";
import { EMPTY_PROCESS_ANSWER, EMPTY_TECHNICAL_ANSWER } from "../../src/lib/knowledge/answerSchema";

async function testMarkdownAndDocx() {
  const md = buildFullAnalysisMarkdown({
    question: "Wie funktioniert Optitool Update?",
    processAnswer: {
      ...EMPTY_PROCESS_ANSWER,
      direct_answer: "Technischer Mechanismus teilweise belegt.",
      confirmed: [
        {
          text: "Einstieg über Klasse X.",
          level: "confirmed",
          source_ranks: [1],
          source_ids: [],
        },
      ],
      has_safe_process_claim: true,
    },
    technicalAnswer: {
      ...EMPTY_TECHNICAL_ANSWER,
      entry_point: [
        {
          text: "Methode RUN startet den Import.",
          level: "confirmed",
          source_ranks: [1],
          source_ids: [],
        },
      ],
    },
    sources: [
      {
        rank: 1,
        title: "CL_OPTITOOL",
        source_key: "code:CL_OPTITOOL",
        knowledge_unit_type: "code_unit",
        object_name: "CL_OPTITOOL",
        subobject_name: "RUN",
        snippet: "Import startet …",
        combined_score: 12.5,
      },
    ],
    retrievalSummary: "12 Treffer aus 1000 Dokumenten",
    durationMs: 45000,
  });

  assert.ok(md.includes("# Vollanalyse"));
  assert.ok(md.includes("Optitool"));
  assert.ok(md.includes("Prozessbewertung"));
  assert.ok(md.includes("Technische Tiefe"));
  assert.ok(md.includes(FULL_ANALYSIS_VERSION));

  const buf = await markdownToDocxBuffer(md);
  assert.ok(buf.length > 1000, "docx should be non-trivial");
  // ZIP/OOXML magic
  assert.equal(buf[0], 0x50);
  assert.equal(buf[1], 0x4b);
  console.log("ok fullAnalysisReport markdown + docx");
}

testMarkdownAndDocx().catch((e) => {
  console.error(e);
  process.exit(1);
});
